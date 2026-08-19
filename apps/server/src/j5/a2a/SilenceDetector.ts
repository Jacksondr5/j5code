import {
  OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { deliveryMessageId } from "./DeliveryTransport.ts";
import { formatSilenceNoticeEnvelope } from "./EnvelopeFormatter.ts";
import { A2ALedger } from "./LedgerService.ts";
import {
  CommCommandId,
  CorrelationId,
  SquadronId,
  ExchangeId,
  GLOBAL_HUMAN_PARTICIPANT_ID,
  LedgerMessageId,
  MessageDeliveredPayload,
  ParticipantId,
  SILENCE_DETECTOR_PARTICIPANT_ID,
  type StoredCommEvent,
} from "./contracts.ts";

export const STOPPED_NOTICE_INSTRUCTION =
  "Do not retry this work or replace the agent automatically; wait for operator direction." as const;

const noticeBase = {
  subjectId: ParticipantId,
  deliveryMessageId: LedgerMessageId,
  observedAt: Schema.String,
} as const;

export const SilenceNoticePayload = Schema.Union([
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("turn-ended-no-reply"),
    runId: Schema.NullOr(RunId),
    processing: Schema.Literals(["processed", "never-processed"]),
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("errored"),
    runId: RunId,
    detail: OrchestrationV2ProviderFailure,
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("stopped/cancelled"),
    runId: RunId,
    lifecycleStatus: Schema.Literals(["interrupted", "cancelled", "rolled_back"]),
    instruction: Schema.Literal(STOPPED_NOTICE_INSTRUCTION),
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("awaiting-human"),
    runId: RunId,
    humanState: Schema.Literals(["human-knows", "human-doesnt-know"]),
    humanExchangeId: ExchangeId,
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("blocked-on-peer"),
    runId: RunId,
    peerId: ParticipantId,
    peerExchangeId: ExchangeId,
  }),
]);
export type SilenceNoticePayload = typeof SilenceNoticePayload.Type;
export type SilenceNoticeState = SilenceNoticePayload["state"];

interface SilenceNoticeBase {
  readonly subjectId: ParticipantId;
  readonly runId: RunId;
  readonly deliveryMessageId: LedgerMessageId;
  readonly observedAt: string;
}

export class A2ASilenceDetectorError extends Schema.TaggedErrorClass<A2ASilenceDetectorError>()(
  "A2ASilenceDetectorError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface A2ASilenceDetectorShape {
  readonly handleStoredEvent: (
    event: OrchestrationV2StoredEvent,
  ) => Effect.Effect<ReadonlyArray<StoredCommEvent>, A2ASilenceDetectorError>;
  readonly handleDeliveryEvent: (
    event: StoredCommEvent,
  ) => Effect.Effect<ReadonlyArray<StoredCommEvent>, A2ASilenceDetectorError>;
  readonly reconcileOpenExchanges: Effect.Effect<
    ReadonlyArray<StoredCommEvent>,
    A2ASilenceDetectorError
  >;
}

export class A2ASilenceDetector extends Context.Service<
  A2ASilenceDetector,
  A2ASilenceDetectorShape
>()("t3/j5/a2a/SilenceDetector/A2ASilenceDetector") {}

interface MembershipRow {
  readonly squadron_id: string;
  readonly participant_id: string;
}

interface ExchangeRow {
  readonly squadron_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly created_at: string;
}

interface DeliveredMessageRow {
  readonly message_id: string;
  readonly delivered_at: string;
}

interface OpenDeliveryRow extends ExchangeRow, DeliveredMessageRow {
  readonly thread_id: string;
}

interface DeliveryStateRow {
  readonly status: "pending" | "retry_scheduled" | "delivered" | "alarmed";
}

interface CursorRow {
  readonly after_sequence: number | null;
}

const detectorError = (operation: string) => (cause: unknown) =>
  new A2ASilenceDetectorError({ operation, cause });

const decodeMessageDelivered = Schema.decodeUnknownEffect(MessageDeliveredPayload);
const decodeSilenceNotice = Schema.decodeUnknownEffect(SilenceNoticePayload);

const terminalRun = (stored: OrchestrationV2StoredEvent): OrchestrationV2Run | undefined => {
  const event = stored.event;
  return event.type === "run.updated" && ThreadManagement.isTerminalRunStatus(event.payload.status)
    ? event.payload
    : undefined;
};

const stablePart = (value: string) => encodeURIComponent(value);

const noticeIdentity = (squadronId: string, exchangeId: string, deliveryMessageId: string) =>
  `${stablePart(squadronId)}:${stablePart(exchangeId)}:${stablePart(deliveryMessageId)}`;

const commandIdFor = (squadronId: string, exchangeId: string, deliveryMessageId: string) =>
  CommCommandId.make(
    `command:j5:a2a:silence:${noticeIdentity(squadronId, exchangeId, deliveryMessageId)}`,
  );

const messageIdFor = (squadronId: string, exchangeId: string, deliveryMessageId: string) =>
  LedgerMessageId.make(
    `message:j5:a2a:silence:${noticeIdentity(squadronId, exchangeId, deliveryMessageId)}`,
  );

const correlationIdFor = (squadronId: string, exchangeId: string, deliveryMessageId: string) =>
  CorrelationId.make(
    `correlation:j5:a2a:silence:${noticeIdentity(squadronId, exchangeId, deliveryMessageId)}`,
  );

const noticeMessage = (payload: SilenceNoticePayload, exchangeId: ExchangeId): string => {
  switch (payload.state) {
    case "turn-ended-no-reply":
      return payload.processing === "never-processed"
        ? `${payload.subjectId} did not start a turn for the delivered message on ${exchangeId}.`
        : `${payload.subjectId}'s turn ended without replying on ${exchangeId}. The latest delivered message was processed.`;
    case "errored":
      return `${payload.subjectId} errored without replying on ${exchangeId}: ${payload.detail.message}`;
    case "stopped/cancelled":
      return `${payload.subjectId} was ${payload.lifecycleStatus} without replying on ${exchangeId}. ${payload.instruction}`;
    case "awaiting-human":
      return `${payload.subjectId} is awaiting the human on ${payload.humanExchangeId} (${payload.humanState}).`;
    case "blocked-on-peer":
      return `${payload.subjectId} is blocked on ${payload.peerId} via ${payload.peerExchangeId}.`;
  }
};

const runCoversDelivery = (
  run: OrchestrationV2Run,
  deliveredAt: string,
  messageId: LedgerMessageId,
): boolean => {
  if (run.userMessageId === deliveryMessageId(messageId)) return true;
  const delivered = DateTime.toEpochMillis(DateTime.makeUnsafe(deliveredAt));
  const completed = run.completedAt === null ? null : DateTime.toEpochMillis(run.completedAt);
  return completed === null || delivered <= completed;
};

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    A2ASilenceDetector,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const deliveryWorker = yield* A2ADeliveryWorker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;

      const failureDetail = Effect.fn("j5.a2a.silence.failureDetail")(function* (
        threadId: ThreadId,
        runId: RunId,
      ) {
        const projection = yield* threads.getThreadProjection(threadId);
        const item = projection.turnItems.findLast(
          (candidate) =>
            candidate.runId === runId &&
            candidate.type === "error" &&
            candidate.status === "failed",
        );
        return item?.type === "error"
          ? item.failure
          : {
              class: "unknown" as const,
              message: "The provider run failed without a persisted error detail.",
              code: null,
              retryable: null,
            };
      });

      const dependencyNotice = Effect.fn("j5.a2a.silence.dependencyNotice")(function* (
        base: SilenceNoticeBase,
      ) {
        const outbound = yield* sql<ExchangeRow>`
          SELECT squadron_id, exchange_id, sender_id, receiver_id, created_at
          FROM j5_a2a_exchange
          WHERE sender_id = ${base.subjectId} AND status = 'open'
          ORDER BY created_at DESC, squadron_id, exchange_id
        `;
        for (const exchange of outbound) {
          const exchangeId = ExchangeId.make(exchange.exchange_id);
          if (exchange.receiver_id !== GLOBAL_HUMAN_PARTICIPANT_ID) {
            return {
              ...base,
              state: "blocked-on-peer" as const,
              peerId: ParticipantId.make(exchange.receiver_id),
              peerExchangeId: exchangeId,
            };
          }
          const inbox = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_human_inbox_data
            WHERE origin_squadron_id = ${exchange.squadron_id}
              AND exchange_id = ${exchange.exchange_id}
          `;
          if ((inbox[0]?.count ?? 0) > 0) {
            return {
              ...base,
              state: "awaiting-human" as const,
              humanState: "human-knows" as const,
              humanExchangeId: exchangeId,
            };
          }
          const states = yield* sql<DeliveryStateRow>`
            SELECT status
            FROM j5_a2a_delivery
            WHERE squadron_id = ${exchange.squadron_id}
              AND exchange_id = ${exchange.exchange_id}
            ORDER BY sent_seq DESC
            LIMIT 1
          `;
          if (states[0]?.status === "alarmed") {
            return {
              ...base,
              state: "awaiting-human" as const,
              humanState: "human-doesnt-know" as const,
              humanExchangeId: exchangeId,
            };
          }
        }
        return null;
      });

      const deriveNotice = Effect.fn("j5.a2a.silence.deriveNotice")(function* (
        run: OrchestrationV2Run,
        threadId: ThreadId,
        subjectId: ParticipantId,
        delivery: DeliveredMessageRow,
        observedAt: string,
      ) {
        const base = {
          subjectId,
          runId: run.id,
          deliveryMessageId: LedgerMessageId.make(delivery.message_id),
          observedAt,
        };
        switch (run.status) {
          case "failed":
            return {
              ...base,
              state: "errored" as const,
              detail: yield* failureDetail(threadId, run.id),
            };
          case "interrupted":
          case "cancelled":
          case "rolled_back":
            return {
              ...base,
              state: "stopped/cancelled" as const,
              lifecycleStatus: run.status,
              instruction: STOPPED_NOTICE_INSTRUCTION,
            };
          case "completed": {
            const dependency = yield* dependencyNotice(base);
            return (
              dependency ?? {
                ...base,
                state: "turn-ended-no-reply" as const,
                // Lifecycle queries only select deliveries at or before this run ended.
                // The delivery/reconciliation path exclusively owns never-processed.
                processing: "processed" as const,
              }
            );
          }
          case "preparing":
          case "queued":
          case "starting":
          case "running":
          case "waiting":
            throw new Error(`Nonterminal run reached silence derivation: ${run.status}`);
        }
      });

      const appendNotice = Effect.fn("j5.a2a.silence.appendNotice")(function* (
        exchange: ExchangeRow,
        payload: SilenceNoticePayload,
      ) {
        yield* decodeSilenceNotice(payload);
        const prior = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM j5_a2a_comm_event
          WHERE squadron_id = ${exchange.squadron_id}
            AND kind = 'silence.notice'
            AND exchange_id = ${exchange.exchange_id}
            AND json_extract(payload, '$.deliveryMessageId') = ${payload.deliveryMessageId}
        `;
        if ((prior[0]?.count ?? 0) > 0) return [];

        const exchangeId = ExchangeId.make(exchange.exchange_id);
        const messageId = messageIdFor(
          exchange.squadron_id,
          exchange.exchange_id,
          payload.deliveryMessageId,
        );
        const correlationId = correlationIdFor(
          exchange.squadron_id,
          exchange.exchange_id,
          payload.deliveryMessageId,
        );
        const result = yield* ledger.appendEvents({
          commandId: commandIdFor(
            exchange.squadron_id,
            exchange.exchange_id,
            payload.deliveryMessageId,
          ),
          squadronId: SquadronId.make(exchange.squadron_id),
          acceptedAt: payload.observedAt,
          events: [
            {
              kind: "silence.notice",
              sender: null,
              receiver: ParticipantId.make(exchange.sender_id),
              exchangeId,
              correlationId,
              payload,
              createdAt: payload.observedAt,
            },
            {
              kind: "message.sent",
              sender: SILENCE_DETECTOR_PARTICIPANT_ID,
              receiver: ParticipantId.make(exchange.sender_id),
              exchangeId: null,
              correlationId,
              payload: {
                messageId,
                text: formatSilenceNoticeEnvelope({
                  noticeType: payload.state,
                  message: noticeMessage(payload, exchangeId),
                }),
                originSquadronId: SquadronId.make(exchange.squadron_id),
                receiverSquadronId: SquadronId.make(exchange.squadron_id),
                exchangeRole: "none",
                envelopeChannel: "silence_notice",
              },
              createdAt: payload.observedAt,
            },
          ],
        });
        return result.committed
          ? result.events.filter((event) => event.kind === "silence.notice")
          : [];
      });

      const inspectOpenDelivery = Effect.fn("j5.a2a.silence.inspectOpenDelivery")(function* (
        row: OpenDeliveryRow,
        observedAt: string,
      ) {
        const subjectId = ParticipantId.make(row.receiver_id);
        const messageId = LedgerMessageId.make(row.message_id);
        const threadId = ThreadId.make(row.thread_id);
        const projection = yield* threads.getThreadProjection(threadId);
        const run = projection.runs.findLast((candidate) =>
          runCoversDelivery(candidate, row.delivered_at, messageId),
        );
        let payload: SilenceNoticePayload;
        if (run === undefined) {
          payload = {
            subjectId,
            runId: null,
            deliveryMessageId: messageId,
            observedAt,
            state: "turn-ended-no-reply",
            processing: "never-processed",
          };
        } else if (ThreadManagement.isTerminalRunStatus(run.status) && run.completedAt !== null) {
          payload = yield* deriveNotice(run, threadId, subjectId, row, observedAt);
        } else {
          return [];
        }
        return yield* appendNotice(row, payload);
      });

      const handleDeliveryEventRaw = Effect.fn("j5.a2a.silence.handleDeliveryEvent")(function* (
        event: StoredCommEvent,
      ) {
        if (
          event.kind !== "message.delivered" ||
          event.receiver === null ||
          event.receiver === GLOBAL_HUMAN_PARTICIPANT_ID
        ) {
          return [];
        }
        const payload = yield* decodeMessageDelivered(event.payload);
        const rows = yield* sql<OpenDeliveryRow>`
          SELECT
            exchange.squadron_id,
            exchange.exchange_id,
            exchange.sender_id,
            exchange.receiver_id,
            exchange.created_at,
            membership.thread_id,
            delivery.message_id,
            ${event.createdAt} AS delivered_at
          FROM j5_a2a_delivery AS delivery
          JOIN j5_a2a_exchange AS exchange
            ON exchange.squadron_id = delivery.squadron_id
           AND exchange.exchange_id = delivery.exchange_id
          JOIN j5_a2a_squadron_membership AS membership
            ON membership.participant_id = exchange.receiver_id
          WHERE delivery.squadron_id = ${event.squadronId}
            AND delivery.message_id = ${payload.messageId}
            AND delivery.envelope_channel = 'peer'
            AND exchange.status = 'open'
          LIMIT 2
        `;
        if (rows.length !== 1) return [];
        const appended = yield* inspectOpenDelivery(rows[0]!, event.createdAt);
        if (appended.length > 0) yield* deliveryWorker.notify;
        return appended;
      });

      const reconcileOpenExchangesRaw = Effect.fn("j5.a2a.silence.reconcileOpenExchanges")(
        function* () {
          const rows = yield* sql<OpenDeliveryRow>`
            SELECT
              exchange.squadron_id,
              exchange.exchange_id,
              exchange.sender_id,
              exchange.receiver_id,
              exchange.created_at,
              membership.thread_id,
              json_extract(delivered.payload, '$.messageId') AS message_id,
              delivered.created_at AS delivered_at
            FROM j5_a2a_exchange AS exchange
            JOIN j5_a2a_squadron_membership AS membership
              ON membership.participant_id = exchange.receiver_id
            JOIN j5_a2a_comm_event AS delivered
              ON delivered.squadron_id = exchange.squadron_id
             AND delivered.exchange_id = exchange.exchange_id
             AND delivered.kind = 'message.delivered'
            JOIN j5_a2a_delivery AS delivery
              ON delivery.squadron_id = exchange.squadron_id
             AND delivery.message_id = json_extract(delivered.payload, '$.messageId')
             AND delivery.envelope_channel = 'peer'
            WHERE exchange.status = 'open'
              AND exchange.receiver_id <> ${GLOBAL_HUMAN_PARTICIPANT_ID}
              AND delivered.seq = (
                SELECT MAX(candidate.seq)
                FROM j5_a2a_comm_event AS candidate
                WHERE candidate.squadron_id = exchange.squadron_id
                  AND candidate.exchange_id = exchange.exchange_id
                  AND candidate.kind = 'message.delivered'
              )
            ORDER BY delivered.created_at, exchange.squadron_id, exchange.exchange_id
          `;
          const appended: Array<StoredCommEvent> = [];
          for (const row of rows) {
            appended.push(...(yield* inspectOpenDelivery(row, row.delivered_at)));
          }
          if (appended.length > 0) yield* deliveryWorker.notify;
          return appended;
        },
      );

      const handleStoredEventRaw = Effect.fn("j5.a2a.silence.handleStoredEvent")(function* (
        stored: OrchestrationV2StoredEvent,
      ) {
        const run = terminalRun(stored);
        if (run === undefined || run.completedAt === null) return [];
        const memberships = yield* sql<MembershipRow>`
          SELECT squadron_id, participant_id
          FROM j5_a2a_squadron_membership
          WHERE thread_id = ${stored.event.threadId}
          ORDER BY squadron_id, participant_id
          LIMIT 2
        `;
        if (memberships.length !== 1) return [];
        const subjectId = ParticipantId.make(memberships[0]!.participant_id);
        const inbound = yield* sql<ExchangeRow>`
          SELECT squadron_id, exchange_id, sender_id, receiver_id, created_at
          FROM j5_a2a_exchange
          WHERE receiver_id = ${subjectId} AND status = 'open'
          ORDER BY created_at, squadron_id, exchange_id
        `;
        const appended: Array<StoredCommEvent> = [];
        for (const exchange of inbound) {
          const delivered = yield* sql<DeliveredMessageRow>`
            SELECT
              json_extract(payload, '$.messageId') AS message_id,
              created_at AS delivered_at
            FROM j5_a2a_comm_event
            WHERE squadron_id = ${exchange.squadron_id}
              AND kind = 'message.delivered'
              AND exchange_id = ${exchange.exchange_id}
              AND receiver = ${subjectId}
              AND created_at <= ${DateTime.formatIso(run.completedAt)}
            ORDER BY seq DESC
            LIMIT 1
          `;
          const delivery = delivered[0];
          if (delivery === undefined) continue;
          const payload = yield* deriveNotice(
            run,
            stored.event.threadId,
            subjectId,
            delivery,
            DateTime.formatIso(stored.event.occurredAt),
          );
          appended.push(...(yield* appendNotice(exchange, payload)));
        }
        if (appended.length > 0) yield* deliveryWorker.notify;
        return appended;
      });

      const handleStoredEvent: A2ASilenceDetectorShape["handleStoredEvent"] = (event) =>
        handleStoredEventRaw(event).pipe(Effect.mapError(detectorError("handle lifecycle event")));

      const handleDeliveryEvent: A2ASilenceDetectorShape["handleDeliveryEvent"] = (event) =>
        handleDeliveryEventRaw(event).pipe(Effect.mapError(detectorError("handle delivery event")));

      const reconcileOpenExchanges = reconcileOpenExchangesRaw().pipe(
        Effect.mapError(detectorError("reconcile open exchanges")),
      );

      const readCursor = Effect.fn("j5.a2a.silence.readCursor")(function* () {
        const rows = yield* sql<CursorRow>`
          SELECT after_sequence
          FROM j5_a2a_silence_detector_cursor
          WHERE singleton = 1
        `;
        return rows[0]?.after_sequence ?? null;
      });

      const writeCursor = Effect.fn("j5.a2a.silence.writeCursor")(function* (sequence: number) {
        const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* sql`
          UPDATE j5_a2a_silence_detector_cursor
          SET after_sequence = ${sequence}, updated_at = ${now}
          WHERE singleton = 1
            AND (after_sequence IS NULL OR after_sequence < ${sequence})
        `;
      });

      const initializeCursor = Effect.fn("j5.a2a.silence.initializeCursor")(function* () {
        const existing = yield* readCursor();
        if (existing !== null) return existing;
        const highWaterRows = yield* sql<{ readonly sequence: number }>`
          SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM orchestration_v2_events
        `;
        const highWater = highWaterRows[0]?.sequence ?? 0;
        yield* reconcileOpenExchangesRaw();
        yield* writeCursor(highWater);
        return highWater;
      });

      let lifecycleRetryDelayMs = 250;

      const prepareLifecycleStream = Effect.gen(function* () {
        const existing = yield* readCursor();
        if (existing === null) {
          yield* initializeCursor();
        } else {
          yield* reconcileOpenExchangesRaw();
        }
      });

      const runLifecycleStream = Effect.gen(function* () {
        const existing = yield* readCursor();
        let checkpoint = existing ?? (yield* initializeCursor());
        yield* threads.streamStoredEventsFrom({ afterSequence: checkpoint }).pipe(
          Stream.runForEach((event) =>
            handleStoredEventRaw(event).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  if (terminalRun(event) !== undefined || event.sequence - checkpoint >= 128) {
                    yield* writeCursor(event.sequence);
                    checkpoint = event.sequence;
                  }
                  lifecycleRetryDelayMs = 250;
                }),
              ),
            ),
          ),
        );
        return yield* Effect.die("J5 A2A lifecycle subscription ended");
      });

      const waitAfterLifecycleFailure = (cause: unknown) => {
        const delayMs = lifecycleRetryDelayMs;
        lifecycleRetryDelayMs = Math.min(delayMs * 2, 30_000);
        return Effect.logWarning("J5 A2A lifecycle subscription failed; resuming from cursor", {
          cause,
          retryDelayMs: delayMs,
        }).pipe(Effect.andThen(Effect.sleep(Duration.millis(delayMs))));
      };

      const runLifecycleDaemon = Effect.gen(function* () {
        let prepared = false;
        while (!prepared) {
          prepared = yield* prepareLifecycleStream.pipe(
            Effect.as(true),
            Effect.catchCause((cause) => waitAfterLifecycleFailure(cause).pipe(Effect.as(false))),
          );
        }
        lifecycleRetryDelayMs = 250;
        return yield* Effect.forever(
          runLifecycleStream.pipe(Effect.catchCause(waitAfterLifecycleFailure)),
        );
      });

      if (daemon) {
        const committed = yield* ledger.subscribeCommitted;
        yield* committed.pipe(
          Stream.runForEach((event) =>
            handleDeliveryEvent(event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 A2A delivery silence check failed; reconciling open work", {
                  cause,
                }).pipe(
                  Effect.andThen(reconcileOpenExchangesRaw()),
                  Effect.catchCause((reconcileCause) =>
                    Effect.logError("J5 A2A delivery silence reconciliation failed", {
                      cause: reconcileCause,
                    }),
                  ),
                ),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Effect.forkScoped(runLifecycleDaemon);
      }

      return A2ASilenceDetector.of({
        handleStoredEvent,
        handleDeliveryEvent,
        reconcileOpenExchanges,
      });
    }),
  );

export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);

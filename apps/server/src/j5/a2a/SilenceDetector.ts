import {
  OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { formatSilenceNoticeEnvelope } from "./EnvelopeFormatter.ts";
import { A2ALedger } from "./LedgerService.ts";
import {
  CommCommandId,
  type CommEvent,
  CorrelationId,
  SquadronId,
  ExchangeId,
  GLOBAL_HUMAN_PARTICIPANT_ID,
  LedgerMessageId,
  ParticipantId,
  type StoredCommEvent,
} from "./contracts.ts";

export const STOPPED_NOTICE_INSTRUCTION =
  "Do not retry this work or replace the agent automatically; wait for operator direction." as const;

const noticeBase = {
  subjectId: ParticipantId,
  runId: RunId,
  deliveryMessageId: LedgerMessageId,
  observedAt: Schema.String,
} as const;

export const SilenceNoticePayload = Schema.Union([
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("turn-ended-no-reply"),
    processing: Schema.Literals(["processed", "never-processed"]),
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("errored"),
    detail: OrchestrationV2ProviderFailure,
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("stopped/cancelled"),
    lifecycleStatus: Schema.Literals(["interrupted", "cancelled", "rolled_back"]),
    instruction: Schema.Literal(STOPPED_NOTICE_INSTRUCTION),
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("awaiting-human"),
    humanState: Schema.Literals(["human-knows", "human-doesnt-know"]),
    humanExchangeId: ExchangeId,
  }),
  Schema.Struct({
    ...noticeBase,
    state: Schema.Literal("blocked-on-peer"),
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

interface DeliveryStateRow {
  readonly status: "pending" | "retry_scheduled" | "delivered" | "alarmed";
}

const detectorError = (operation: string) => (cause: unknown) =>
  new A2ASilenceDetectorError({ operation, cause });

const terminalRun = (stored: OrchestrationV2StoredEvent): OrchestrationV2Run | undefined => {
  const event = stored.event;
  return event.type === "run.updated" && ThreadManagement.isTerminalRunStatus(event.payload.status)
    ? event.payload
    : undefined;
};

const stablePart = (value: string | number) => encodeURIComponent(String(value));

const commandIdFor = (sequence: number, exchangeId: string) =>
  CommCommandId.make(`command:j5:a2a:silence:${stablePart(sequence)}:${stablePart(exchangeId)}`);

const messageIdFor = (sequence: number, exchangeId: string) =>
  LedgerMessageId.make(`message:j5:a2a:silence:${stablePart(sequence)}:${stablePart(exchangeId)}`);

const correlationIdFor = (sequence: number, exchangeId: string) =>
  CorrelationId.make(
    `correlation:j5:a2a:silence:${stablePart(sequence)}:${stablePart(exchangeId)}`,
  );

const noticeMessage = (payload: SilenceNoticePayload, exchangeId: ExchangeId): string => {
  switch (payload.state) {
    case "turn-ended-no-reply":
      return `${payload.subjectId}'s turn ended without replying on ${exchangeId}. The latest delivered message was ${payload.processing}.`;
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

const processingState = (
  deliveredAt: string,
  startedAt: OrchestrationV2Run["startedAt"],
): "processed" | "never-processed" =>
  startedAt !== null &&
  DateTime.toEpochMillis(DateTime.makeUnsafe(deliveredAt)) <= DateTime.toEpochMillis(startedAt)
    ? "processed"
    : "never-processed";

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
          ORDER BY created_at, squadron_id, exchange_id
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
                processing: processingState(delivery.delivered_at, run.startedAt),
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
          const prior = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_comm_event
            WHERE squadron_id = ${exchange.squadron_id}
              AND kind = 'silence.notice'
              AND exchange_id = ${exchange.exchange_id}
              AND json_extract(payload, '$.deliveryMessageId') = ${delivery.message_id}
          `;
          if ((prior[0]?.count ?? 0) > 0) continue;

          const exchangeId = ExchangeId.make(exchange.exchange_id);
          const payload = yield* deriveNotice(
            run,
            stored.event.threadId,
            subjectId,
            delivery,
            DateTime.formatIso(stored.event.occurredAt),
          );
          const messageId = messageIdFor(stored.sequence, exchange.exchange_id);
          const correlationId = correlationIdFor(stored.sequence, exchange.exchange_id);
          const events: ReadonlyArray<CommEvent> = [
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
              sender: subjectId,
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
          ];
          const result = yield* ledger.appendEvents({
            commandId: commandIdFor(stored.sequence, exchange.exchange_id),
            squadronId: SquadronId.make(exchange.squadron_id),
            acceptedAt: payload.observedAt,
            events,
          });
          if (result.committed) {
            appended.push(...result.events.filter((event) => event.kind === "silence.notice"));
          }
        }
        if (appended.length > 0) yield* deliveryWorker.notify;
        return appended;
      });

      const handleStoredEvent: A2ASilenceDetectorShape["handleStoredEvent"] = (event) =>
        handleStoredEventRaw(event).pipe(Effect.mapError(detectorError("handle lifecycle event")));

      if (daemon) {
        yield* threads.streamStoredEventsFrom({ afterSequence: 0 }).pipe(
          Stream.runForEach(handleStoredEvent),
          Effect.catchCause((cause) =>
            Effect.logError("J5 A2A silence detector stopped", { cause }),
          ),
          Effect.forkScoped,
        );
      }

      return A2ASilenceDetector.of({ handleStoredEvent });
    }),
  );

export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);

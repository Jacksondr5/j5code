import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import {
  type ArchiveParticipantInput,
  CommCommandId,
  CorrelationId,
  SquadronId,
  ExchangeId,
  type ExchangeDropDisposition,
  isHumanParticipantId,
  LIFECYCLE_PARTICIPANT_ID,
  LedgerMessageId,
  type LifecycleArchiveResult,
  Participant,
  ParticipantId,
} from "./contracts.ts";
import { resolveThreadHome } from "./HomeRegistrar.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";

export class A2ALifecycleParticipantNotFoundError extends Schema.TaggedErrorClass<A2ALifecycleParticipantNotFoundError>()(
  "A2ALifecycleParticipantNotFoundError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} does not exist and cannot be archived.`;
  }
}

export class A2ALifecycleHumanArchiveNotAllowedError extends Schema.TaggedErrorClass<A2ALifecycleHumanArchiveNotAllowedError>()(
  "A2ALifecycleHumanArchiveNotAllowedError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} is a person. This operation archives agents only.`;
  }
}

export class A2ALifecycleCounterpartyStateError extends Schema.TaggedErrorClass<A2ALifecycleCounterpartyStateError>()(
  "A2ALifecycleCounterpartyStateError",
  {
    participantId: Schema.String,
    exchangeId: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot close exchange ${this.exchangeId}: affected participant ${this.participantId} has no readable Squadron projection.`;
  }
}

export class A2ALifecycleParticipantHomeStateError extends Schema.TaggedErrorClass<A2ALifecycleParticipantHomeStateError>()(
  "A2ALifecycleParticipantHomeStateError",
  {
    participantId: Schema.String,
    squadronIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Participant ${this.participantId} has ambiguous immutable home history (${this.squadronIds.join(", ")}). Repair history before lifecycle retirement resumes.`;
  }
}

export class A2ALifecycleBridgeError extends Schema.TaggedErrorClass<A2ALifecycleBridgeError>()(
  "A2ALifecycleBridgeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export type A2ALifecycleError =
  | A2ALedgerError
  | Schema.SchemaError
  | SqlError
  | A2ALifecycleParticipantNotFoundError
  | A2ALifecycleHumanArchiveNotAllowedError
  | A2ALifecycleCounterpartyStateError
  | A2ALifecycleParticipantHomeStateError;

export interface A2ALifecycleServiceShape {
  /** Platform lifecycle authority only. This service is deliberately absent from the agent MCP toolkit. */
  readonly archiveParticipant: (
    input: ArchiveParticipantInput,
  ) => Effect.Effect<LifecycleArchiveResult, A2ALifecycleError>;
  readonly handleStoredEvent: (
    event: OrchestrationV2StoredEvent,
  ) => Effect.Effect<boolean, A2ALifecycleBridgeError>;
  readonly replayCommittedEvents: Effect.Effect<void, A2ALifecycleBridgeError>;
}

export class A2ALifecycleService extends Context.Service<
  A2ALifecycleService,
  A2ALifecycleServiceShape
>()("t3/j5/a2a/LifecycleService/A2ALifecycleService") {}

interface MembershipRow {
  readonly squadron_id: string;
  readonly participant_id: string;
  readonly participant_kind: "agent" | "human";
  readonly payload: string;
}

interface HistoricalParticipantRow {
  readonly squadron_id: string;
  readonly payload: string;
  readonly retired: number;
}

interface ExchangeRow {
  readonly squadron_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
}

interface CursorRow {
  readonly after_sequence: number;
}

const stablePart = (value: string) => encodeURIComponent(value);

const lifecycleKey = (exchange: ExchangeRow, disposition: ExchangeDropDisposition) =>
  `${stablePart(exchange.squadron_id)}:${stablePart(exchange.exchange_id)}:${disposition}`;

const dropCommandId = (exchange: ExchangeRow, disposition: ExchangeDropDisposition) =>
  CommCommandId.make(`command:j5:a2a:lifecycle:drop:${lifecycleKey(exchange, disposition)}`);

const noticeMessageId = (exchange: ExchangeRow, disposition: ExchangeDropDisposition) =>
  LedgerMessageId.make(`message:j5:a2a:lifecycle:drop:${lifecycleKey(exchange, disposition)}`);

const noticeCorrelationId = (exchange: ExchangeRow, disposition: ExchangeDropDisposition) =>
  CorrelationId.make(`correlation:j5:a2a:lifecycle:drop:${lifecycleKey(exchange, disposition)}`);

const participantArchiveCommandId = (squadronId: SquadronId, participantId: ParticipantId) =>
  CommCommandId.make(
    `command:j5:a2a:lifecycle:participant:${stablePart(squadronId)}:${stablePart(participantId)}`,
  );

export const formatLifecycleNotice = (input: {
  readonly exchangeId: ExchangeId;
  readonly retiredParticipantId: ParticipantId;
  readonly disposition: ExchangeDropDisposition;
}): string => {
  const consequence =
    input.disposition === "receiver-retired"
      ? "The receiver can no longer answer. Do not retry this exchange and do not replace the retired participant."
      : "The asker is gone. Your reply obligation has ended; do not send a replacement reply.";
  return [
    `[Cross-agent messaging system notice: exchange dropped]`,
    `Exchange ${input.exchangeId} ended because ${input.retiredParticipantId} was retired from A2A (${input.disposition}).`,
    consequence,
    "Facts: replyRequired=false; retryAllowed=false; replacementRequired=false.",
    "This is a platform-authored terminal notice, not a peer reply.",
  ].join("\n\n");
};

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

const bridgeError = (operation: string) => (cause: unknown) =>
  new A2ALifecycleBridgeError({ operation, cause });

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    A2ALifecycleService,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const worker = yield* A2ADeliveryWorker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const lifecyclePermit = yield* Semaphore.make(1);

      const membershipRows = Effect.fn("j5.a2a.lifecycle.membershipRows")(function* (
        participantId: ParticipantId,
      ) {
        return yield* sql<MembershipRow>`
          SELECT squadron_id, participant_id, participant_kind, payload
          FROM j5_a2a_squadron_membership
          WHERE participant_id = ${participantId}
          ORDER BY squadron_id
        `;
      });

      const historicalParticipantRows = Effect.fn("j5.a2a.lifecycle.historicalParticipantRows")(
        function* (participantId: ParticipantId) {
          return yield* sql<HistoricalParticipantRow>`
          SELECT
            joined.squadron_id,
            json_extract(joined.payload, '$.participant') AS payload,
            EXISTS (
              SELECT 1
              FROM j5_a2a_comm_event AS retirement
              WHERE retirement.squadron_id = joined.squadron_id
                AND retirement.seq > joined.seq
                AND retirement.kind = 'participant.left'
                AND json_extract(retirement.payload, '$.participant.kind') = 'agent'
                AND json_extract(retirement.payload, '$.participant.id') = ${participantId}
                AND json_extract(retirement.payload, '$.participant.threadId') =
                  json_extract(joined.payload, '$.participant.threadId')
            ) AS retired
          FROM j5_a2a_comm_event AS joined
          WHERE joined.kind = 'participant.joined'
            AND json_extract(joined.payload, '$.participant.id') = ${participantId}
          ORDER BY joined.seq
          LIMIT 2
        `;
        },
      );

      const counterpartySquadron = Effect.fn("j5.a2a.lifecycle.counterpartySquadron")(function* (
        participantId: ParticipantId,
        exchange: ExchangeRow,
      ) {
        if (isHumanParticipantId(participantId)) {
          return SquadronId.make(exchange.squadron_id);
        }
        const rows = yield* membershipRows(participantId);
        const row =
          rows.find((candidate) => candidate.squadron_id === exchange.squadron_id) ?? rows[0];
        if (row !== undefined) return SquadronId.make(row.squadron_id);
        const historical = yield* historicalParticipantRows(participantId);
        const historicalRow =
          historical.find((candidate) => candidate.squadron_id === exchange.squadron_id) ??
          historical[0];
        if (historicalRow === undefined) {
          return yield* new A2ALifecycleCounterpartyStateError({
            participantId,
            exchangeId: exchange.exchange_id,
          });
        }
        return SquadronId.make(historicalRow.squadron_id);
      });

      const dropParticipantExchanges = Effect.fn("j5.a2a.lifecycle.dropParticipantExchanges")(
        function* (input: {
          readonly participantId: ParticipantId;
          readonly squadronId: SquadronId;
          readonly archivedAt: string;
        }) {
          const exchanges = yield* sql<ExchangeRow>`
          SELECT squadron_id, exchange_id, sender_id, receiver_id
          FROM j5_a2a_exchange
          WHERE status = 'open'
            AND (sender_id = ${input.participantId} OR receiver_id = ${input.participantId})
          ORDER BY squadron_id, opened_seq, exchange_id
        `;
          const dropped: Array<ExchangeId> = [];
          for (const exchange of exchanges) {
            const disposition: ExchangeDropDisposition =
              exchange.receiver_id === input.participantId ? "receiver-retired" : "sender-retired";
            const affectedParticipantId = ParticipantId.make(
              disposition === "receiver-retired" ? exchange.sender_id : exchange.receiver_id,
            );
            const exchangeId = ExchangeId.make(exchange.exchange_id);
            const messageId = noticeMessageId(exchange, disposition);
            const correlationId = noticeCorrelationId(exchange, disposition);
            const receiverSquadronId = yield* counterpartySquadron(affectedParticipantId, exchange);
            yield* ledger.appendEvents({
              commandId: dropCommandId(exchange, disposition),
              squadronId: SquadronId.make(exchange.squadron_id),
              acceptedAt: input.archivedAt,
              events: [
                {
                  kind: "exchange.dropped",
                  sender: ParticipantId.make(exchange.sender_id),
                  receiver: ParticipantId.make(exchange.receiver_id),
                  exchangeId,
                  correlationId,
                  payload: {
                    disposition,
                    cause: {
                      kind: "participant-archived",
                      participantId: input.participantId,
                      squadronId: input.squadronId,
                    },
                    facts: {
                      replyRequired: false,
                      retryAllowed: false,
                      replacementRequired: false,
                    },
                    noticeMessageId: messageId,
                  },
                  createdAt: input.archivedAt,
                },
                {
                  kind: "message.sent",
                  sender: LIFECYCLE_PARTICIPANT_ID,
                  receiver: affectedParticipantId,
                  exchangeId,
                  correlationId,
                  payload: {
                    messageId,
                    text: formatLifecycleNotice({
                      exchangeId,
                      retiredParticipantId: input.participantId,
                      disposition,
                    }),
                    originSquadronId: SquadronId.make(exchange.squadron_id),
                    receiverSquadronId,
                    exchangeRole: "terminal_notice",
                    envelopeChannel: "lifecycle_notice",
                  },
                  createdAt: input.archivedAt,
                },
              ],
            });
            dropped.push(exchangeId);
          }
          return dropped;
        },
      );

      const archiveParticipantInternal = Effect.fn("j5.a2a.lifecycle.archiveParticipantInternal")(
        function* (input: ArchiveParticipantInput) {
          const rows = yield* historicalParticipantRows(input.participantId);
          if (rows.length === 0) {
            return yield* new A2ALifecycleParticipantNotFoundError({
              participantId: input.participantId,
            });
          }
          if (rows.length !== 1) {
            return yield* new A2ALifecycleParticipantHomeStateError({
              participantId: input.participantId,
              squadronIds: rows.map((row) => row.squadron_id),
            });
          }
          const row = rows[0]!;
          const squadronId = SquadronId.make(row.squadron_id);
          const participant = yield* decodeParticipant(row.payload);
          if (participant.kind !== "agent") {
            return yield* new A2ALifecycleHumanArchiveNotAllowedError({
              participantId: input.participantId,
            });
          }
          const archived = row.retired === 0;
          yield* ledger.append({
            commandId: participantArchiveCommandId(squadronId, input.participantId),
            squadronId,
            acceptedAt: input.archivedAt,
            event: {
              kind: "participant.left",
              sender: null,
              receiver: input.participantId,
              exchangeId: null,
              correlationId: null,
              payload: { participant },
              createdAt: input.archivedAt,
            },
          });
          const droppedExchangeIds = yield* dropParticipantExchanges({
            participantId: input.participantId,
            squadronId,
            archivedAt: input.archivedAt,
          });
          return { archived, droppedExchangeIds } satisfies LifecycleArchiveResult;
        },
      );

      const archiveParticipantRaw = Effect.fn("j5.a2a.lifecycle.archiveParticipant")(function* (
        input: ArchiveParticipantInput,
      ) {
        const result = yield* archiveParticipantInternal(input);
        yield* worker.notify;
        return result;
      });
      const archiveParticipant: A2ALifecycleServiceShape["archiveParticipant"] = (input) =>
        lifecyclePermit.withPermit(archiveParticipantRaw(input));

      const handleStoredEventRaw = Effect.fn("j5.a2a.lifecycle.handleStoredEvent")(function* (
        stored: OrchestrationV2StoredEvent,
      ) {
        if (stored.event.type !== "thread.archived" && stored.event.type !== "thread.deleted") {
          return false;
        }
        const resolution = yield* resolveThreadHome(sql, stored.event.threadId).pipe(
          Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)),
        );
        if (resolution === null) return false;
        yield* archiveParticipant({
          participantId: resolution.home.participantId,
          archivedAt: DateTime.formatIso(stored.event.occurredAt),
        });
        return true;
      });

      const readCursor = Effect.fn("j5.a2a.lifecycle.readCursor")(function* () {
        const rows = yield* sql<CursorRow>`
          SELECT after_sequence
          FROM j5_a2a_lifecycle_cursor
          WHERE singleton = 1
        `;
        return rows[0]?.after_sequence ?? 0;
      });

      const writeCursor = Effect.fn("j5.a2a.lifecycle.writeCursor")(function* (sequence: number) {
        const updatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* sql`
          UPDATE j5_a2a_lifecycle_cursor
          SET after_sequence = ${sequence}, updated_at = ${updatedAt}
          WHERE singleton = 1 AND after_sequence < ${sequence}
        `;
      });

      const replayCommittedEventsRaw = Effect.fn("j5.a2a.lifecycle.replayCommittedEvents")(
        function* () {
          let checkpoint = yield* readCursor();
          let lastSeen = checkpoint;
          yield* threads.streamStoredEventsFrom({ afterSequence: checkpoint }).pipe(
            Stream.runForEach((event) =>
              handleStoredEventRaw(event).pipe(
                Effect.andThen((archived) =>
                  Effect.gen(function* () {
                    lastSeen = event.sequence;
                    if (archived || event.sequence - checkpoint >= 128) {
                      yield* writeCursor(event.sequence);
                      checkpoint = event.sequence;
                    }
                  }),
                ),
              ),
            ),
          );
          if (lastSeen > checkpoint) yield* writeCursor(lastSeen);
        },
      );

      const handleStoredEvent: A2ALifecycleServiceShape["handleStoredEvent"] = (event) =>
        handleStoredEventRaw(event).pipe(Effect.mapError(bridgeError("handle thread retirement")));
      const replayCommittedEvents: A2ALifecycleServiceShape["replayCommittedEvents"] =
        replayCommittedEventsRaw().pipe(Effect.mapError(bridgeError("replay thread retirements")));

      if (daemon) {
        let retryDelayMs = 250;
        const run = Effect.forever(
          replayCommittedEventsRaw().pipe(
            Effect.andThen(Effect.die("J5 A2A lifecycle retirement stream ended")),
            Effect.catchCause((cause) => {
              const delayMs = retryDelayMs;
              retryDelayMs = Math.min(delayMs * 2, 30_000);
              return Effect.logWarning(
                "J5 A2A lifecycle retirement stream failed; resuming from cursor",
                { cause, retryDelayMs: delayMs },
              ).pipe(Effect.andThen(Effect.sleep(Duration.millis(delayMs))));
            }),
          ),
        );
        yield* Effect.forkScoped(run);
      }

      return A2ALifecycleService.of({
        archiveParticipant,
        handleStoredEvent,
        replayCommittedEvents,
      });
    }),
  );

export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);

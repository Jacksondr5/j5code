import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ThreadId } from "@t3tools/contracts";

import {
  type AppendCommEventsCommand,
  CommCommandReceipt,
  type AppendCommEventCommand,
  type CommEventPage,
  type CreateSquadronCommand,
  Squadron,
  ExchangeClosedPayload,
  ExchangeOpenedPayload,
  MessageDeliveredPayload,
  MessageDeliveryFailedPayload,
  MessageSentPayload,
  type SquadronId,
  type LedgerCursor,
  Membership,
  ParticipantId,
  StoredCommEvent,
  participantId,
} from "./contracts.ts";
import { decideAppendCommEvent } from "./decider.ts";

export class A2AStorageError extends Schema.TaggedErrorClass<A2AStorageError>()("A2AStorageError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SquadronNotFoundError extends Schema.TaggedErrorClass<SquadronNotFoundError>()(
  "SquadronNotFoundError",
  { squadronId: Schema.String },
) {}

export class CommCommandConflictError extends Schema.TaggedErrorClass<CommCommandConflictError>()(
  "CommCommandConflictError",
  {
    commandId: Schema.String,
    requestedSquadronId: Schema.String,
    existingSquadronId: Schema.String,
  },
) {}

export class LedgerCursorError extends Schema.TaggedErrorClass<LedgerCursorError>()(
  "LedgerCursorError",
  {
    squadronId: Schema.String,
    afterSeq: Schema.Number,
    snapshotEnd: Schema.Number,
  },
) {}

export class LedgerGapError extends Schema.TaggedErrorClass<LedgerGapError>()("LedgerGapError", {
  squadronId: Schema.String,
  expectedSeq: Schema.Number,
  actualSeq: Schema.NullOr(Schema.Number),
}) {}

export type A2ALedgerError =
  | A2AStorageError
  | SquadronNotFoundError
  | CommCommandConflictError
  | LedgerCursorError
  | LedgerGapError;

const isA2ALedgerError = Schema.is(
  Schema.Union([
    A2AStorageError,
    SquadronNotFoundError,
    CommCommandConflictError,
    LedgerCursorError,
    LedgerGapError,
  ]),
);

export interface AppendResult {
  readonly receipt: CommCommandReceipt;
  readonly event: StoredCommEvent;
  readonly committed: boolean;
}

export interface AppendEventsResult {
  readonly receipt: CommCommandReceipt;
  readonly events: ReadonlyArray<StoredCommEvent>;
  readonly committed: boolean;
}

export interface A2ALedgerShape {
  readonly createSquadron: (
    command: CreateSquadronCommand,
  ) => Effect.Effect<Squadron, A2ALedgerError>;
  readonly listSquadrons: () => Effect.Effect<ReadonlyArray<Squadron>, A2ALedgerError>;
  readonly readSquadron: (squadronId: SquadronId) => Effect.Effect<Squadron, A2ALedgerError>;
  readonly append: (command: AppendCommEventCommand) => Effect.Effect<AppendResult, A2ALedgerError>;
  readonly appendEvents: (
    command: AppendCommEventsCommand,
  ) => Effect.Effect<AppendEventsResult, A2ALedgerError>;
  readonly readEvents: (input: {
    readonly squadronId: SquadronId;
    readonly cursor: LedgerCursor;
    readonly limit: number;
  }) => Effect.Effect<CommEventPage, A2ALedgerError>;
  readonly listMembership: (
    squadronId: SquadronId,
  ) => Effect.Effect<ReadonlyArray<Membership>, A2ALedgerError>;
  readonly findHistoricalAgentParticipantId: (input: {
    readonly squadronId: SquadronId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<ParticipantId | null, A2ALedgerError>;
  readonly rebuildMembership: (
    squadronId: SquadronId,
  ) => Effect.Effect<ReadonlyArray<Membership>, A2ALedgerError>;
  readonly subscribeCommitted: Effect.Effect<Stream.Stream<StoredCommEvent>, never, Scope.Scope>;
}

export class A2ALedger extends Context.Service<A2ALedger, A2ALedgerShape>()(
  "t3/j5/a2a/LedgerService/A2ALedger",
) {}

interface SquadronRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
}

interface EventRow {
  readonly seq: number;
  readonly squadron_id: string;
  readonly kind: string;
  readonly sender: string | null;
  readonly receiver: string | null;
  readonly exchange_id: string | null;
  readonly correlation_id: string | null;
  readonly payload: string;
  readonly created_at: string;
}

interface ReceiptRow {
  readonly command_id: string;
  readonly squadron_id: string;
  readonly command_type: string;
  readonly accepted_at: string;
  readonly result_seq: number;
}

interface MembershipRow {
  readonly squadron_id: string;
  readonly joined_seq: number;
  readonly updated_seq: number;
  readonly payload: string;
}

const decodeSquadron = Schema.decodeUnknownEffect(Squadron);
const decodeParticipantId = Schema.decodeUnknownEffect(ParticipantId);
const decodeStoredEvent = Schema.decodeUnknownEffect(StoredCommEvent);
const decodeReceipt = Schema.decodeUnknownEffect(CommCommandReceipt);
const decodeMembership = Schema.decodeUnknownEffect(Membership);
const decodeExchangeOpened = Schema.decodeUnknownEffect(ExchangeOpenedPayload);
const decodeExchangeClosed = Schema.decodeUnknownEffect(ExchangeClosedPayload);
const decodeMessageSent = Schema.decodeUnknownEffect(MessageSentPayload);
const decodeMessageDelivered = Schema.decodeUnknownEffect(MessageDeliveredPayload);
const decodeMessageDeliveryFailed = Schema.decodeUnknownEffect(MessageDeliveryFailedPayload);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const preserveDomainError =
  (operation: string) =>
  (cause: unknown): A2ALedgerError =>
    isA2ALedgerError(cause) ? cause : new A2AStorageError({ operation, cause });

const squadronFromRow = (row: SquadronRow) =>
  decodeSquadron({ id: row.id, name: row.name, createdAt: row.created_at });

const eventFromRow = Effect.fn("j5.a2a.eventFromRow")(function* (row: EventRow) {
  return yield* decodeStoredEvent({
    seq: row.seq,
    squadronId: row.squadron_id,
    kind: row.kind,
    sender: row.sender,
    receiver: row.receiver,
    exchangeId: row.exchange_id,
    correlationId: row.correlation_id,
    payload: yield* decodeJson(row.payload),
    createdAt: row.created_at,
  });
});

const receiptFromRow = (row: ReceiptRow) =>
  decodeReceipt({
    commandId: row.command_id,
    squadronId: row.squadron_id,
    commandType: row.command_type,
    acceptedAt: row.accepted_at,
    resultSeq: row.result_seq,
  });

const membershipFromRow = Effect.fn("j5.a2a.membershipFromRow")(function* (row: MembershipRow) {
  return yield* decodeMembership({
    squadronId: row.squadron_id,
    participant: yield* decodeJson(row.payload),
    joinedSeq: row.joined_seq,
    updatedSeq: row.updated_seq,
  });
});

export const layer: Layer.Layer<A2ALedger, never, SqlClient.SqlClient> = Layer.effect(
  A2ALedger,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const appendPermit = yield* Semaphore.make(1);
    const committed = yield* PubSub.unbounded<StoredCommEvent>();

    const ensureSquadron = Effect.fn("j5.a2a.ensureSquadron")(function* (squadronId: SquadronId) {
      const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM j5_a2a_squadron WHERE id = ${squadronId} LIMIT 1
      `;
      if (rows[0] === undefined) {
        return yield* new SquadronNotFoundError({ squadronId });
      }
    });

    const applyMembership = Effect.fn("j5.a2a.applyMembership")(function* (event: StoredCommEvent) {
      if (event.kind !== "participant.joined" && event.kind !== "participant.left") return;
      const participant = event.payload.participant;
      // Historical human membership events remain readable ledger facts. New
      // person addressability is host registry state, never Squadron membership.
      if (participant.kind === "human") return;
      const id = participantId(participant);
      if (event.kind === "participant.left") {
        yield* sql`
          DELETE FROM j5_a2a_squadron_membership
          WHERE squadron_id = ${event.squadronId} AND participant_id = ${id}
        `;
        return;
      }
      const payload = yield* encodeJson(participant);
      const threadId = participant.kind === "agent" ? participant.threadId : null;
      yield* sql`
        INSERT INTO j5_a2a_squadron_membership (
          squadron_id,
          participant_id,
          participant_kind,
          thread_id,
          joined_seq,
          updated_seq,
          payload
        ) VALUES (
          ${event.squadronId},
          ${id},
          ${participant.kind},
          ${threadId},
          ${event.seq},
          ${event.seq},
          ${payload}
        )
        ON CONFLICT(squadron_id, participant_id)
        DO UPDATE SET
          participant_kind = excluded.participant_kind,
          thread_id = excluded.thread_id,
          joined_seq = j5_a2a_squadron_membership.joined_seq,
          updated_seq = excluded.updated_seq,
          payload = excluded.payload
      `;
    });

    const applyA2Projection = Effect.fn("j5.a2a.applyA2Projection")(function* (
      event: StoredCommEvent,
      commandId: string,
    ) {
      switch (event.kind) {
        case "exchange.opened": {
          const payload = yield* decodeExchangeOpened(event.payload);
          if (event.sender === null || event.receiver === null || event.exchangeId === null) {
            return yield* new A2AStorageError({ operation: "project opened exchange" });
          }
          yield* sql`
            INSERT INTO j5_a2a_exchange (
              squadron_id,
              exchange_id,
              sender_id,
              receiver_id,
              status,
              intent,
              urgency,
              opened_seq,
              closed_seq,
              created_at,
              updated_at
            ) VALUES (
              ${event.squadronId},
              ${event.exchangeId},
              ${event.sender},
              ${event.receiver},
              'open',
              ${payload.intent},
              ${payload.urgency},
              ${event.seq},
              NULL,
              ${event.createdAt},
              ${event.createdAt}
            )
          `;
          return;
        }
        case "exchange.closed": {
          yield* decodeExchangeClosed(event.payload);
          if (event.exchangeId === null) {
            return yield* new A2AStorageError({ operation: "project closed exchange" });
          }
          yield* sql`
            UPDATE j5_a2a_exchange
            SET
              status = 'closed',
              closed_seq = ${event.seq},
              updated_at = ${event.createdAt}
            WHERE squadron_id = ${event.squadronId}
              AND exchange_id = ${event.exchangeId}
              AND status = 'open'
          `;
          // Human inbox history is an A4-owned ledger projection. Lifecycle
          // producers append terminal facts and never mutate this table.
          yield* sql`
            UPDATE j5_a2a_human_inbox
            SET
              status = 'answered',
              terminal_seq = ${event.seq},
              terminal_at = ${event.createdAt},
              terminal_disposition = 'answered',
              terminal_cause = NULL,
              terminal_facts = NULL,
              terminal_notice_message_id = NULL
            WHERE squadron_id = ${event.squadronId}
              AND exchange_id = ${event.exchangeId}
              AND status = 'open'
          `;
          return;
        }
        case "message.sent": {
          const payload = yield* decodeMessageSent(event.payload);
          if (event.sender === null || event.receiver === null || event.correlationId === null) {
            return yield* new A2AStorageError({ operation: "project sent message" });
          }
          yield* sql`
            INSERT INTO j5_a2a_delivery (
              squadron_id,
              message_id,
              command_id,
              sent_seq,
              sender_id,
              receiver_id,
              receiver_squadron_id,
              exchange_id,
              exchange_role,
              envelope_channel,
              correlation_id,
              message_text,
              status,
              attempts,
              last_error,
              next_attempt_at,
              delivered_seq,
              created_at,
              updated_at
            ) VALUES (
              ${event.squadronId},
              ${payload.messageId},
              ${commandId},
              ${event.seq},
              ${event.sender},
              ${event.receiver},
              ${payload.receiverSquadronId},
              ${event.exchangeId},
              ${payload.exchangeRole},
              ${payload.envelopeChannel},
              ${event.correlationId},
              ${payload.text},
              'pending',
              0,
              NULL,
              NULL,
              NULL,
              ${event.createdAt},
              ${event.createdAt}
            )
          `;
          return;
        }
        case "message.delivered": {
          const payload = yield* decodeMessageDelivered(event.payload);
          const rows = yield* sql<{ readonly message_id: string }>`
            UPDATE j5_a2a_delivery
            SET
              status = 'delivered',
              attempts = ${payload.attempt},
              last_error = NULL,
              next_attempt_at = NULL,
              delivered_seq = ${event.seq},
              updated_at = ${event.createdAt}
            WHERE squadron_id = ${event.squadronId} AND message_id = ${payload.messageId}
            RETURNING message_id
          `;
          if (rows[0] === undefined) {
            return yield* new A2AStorageError({ operation: "project delivered message" });
          }
          return;
        }
        case "message.delivery_failed": {
          const payload = yield* decodeMessageDeliveryFailed(event.payload);
          const rows = yield* sql<{ readonly message_id: string }>`
            UPDATE j5_a2a_delivery
            SET
              status = ${payload.alarmed ? "alarmed" : "retry_scheduled"},
              attempts = ${payload.attempt},
              last_error = ${payload.error},
              next_attempt_at = ${payload.nextAttemptAt},
              updated_at = ${event.createdAt}
            WHERE squadron_id = ${event.squadronId} AND message_id = ${payload.messageId}
            RETURNING message_id
          `;
          if (rows[0] === undefined) {
            return yield* new A2AStorageError({ operation: "project failed message delivery" });
          }
          return;
        }
        case "message.received":
        case "silence.notice":
        case "participant.joined":
        case "participant.left":
          return;
      }
    });

    const listMembershipEffect = Effect.fn("j5.a2a.listMembership")(function* (
      squadronId: SquadronId,
    ) {
      yield* ensureSquadron(squadronId);
      const rows = yield* sql<MembershipRow>`
        SELECT squadron_id, joined_seq, updated_seq, payload
        FROM j5_a2a_squadron_membership
        WHERE squadron_id = ${squadronId}
        ORDER BY participant_id
      `;
      return yield* Effect.forEach(rows, membershipFromRow, { concurrency: 1 });
    });

    const findHistoricalAgentParticipantId = Effect.fn("j5.a2a.findHistoricalAgentParticipantId")(
      function* (input: { readonly squadronId: SquadronId; readonly threadId: ThreadId }) {
        yield* ensureSquadron(input.squadronId);
        const rows = yield* sql<{ readonly participant_id: string }>`
        SELECT DISTINCT json_extract(payload, '$.participant.id') AS participant_id
        FROM j5_a2a_comm_event
        WHERE squadron_id = ${input.squadronId}
          AND kind = 'participant.joined'
          AND json_extract(payload, '$.participant.kind') = 'agent'
          AND json_extract(payload, '$.participant.threadId') = ${input.threadId}
        ORDER BY participant_id
      `;
        return rows.length === 1 ? yield* decodeParticipantId(rows[0]!.participant_id) : null;
      },
    );

    const appendEventsEffect = Effect.fn("j5.a2a.appendEvents")(function* (
      command: AppendCommEventsCommand,
    ) {
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* ensureSquadron(command.squadronId);
          const sequenceRows = yield* sql<{ readonly next_seq: number }>`
            SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
            FROM j5_a2a_comm_event
            WHERE squadron_id = ${command.squadronId}
          `;
          const firstSeq = sequenceRows[0]?.next_seq;
          if (firstSeq === undefined) {
            return yield* new A2AStorageError({ operation: "allocate communication sequences" });
          }
          const resultSeq = firstSeq + command.events.length - 1;
          const reserved = yield* sql<{ readonly command_id: string }>`
            INSERT INTO j5_a2a_comm_command_receipt (
              command_id,
              squadron_id,
              command_type,
              accepted_at,
              result_seq
            ) VALUES (
              ${command.commandId},
              ${command.squadronId},
              'comm.append',
              ${command.acceptedAt},
              ${resultSeq}
            )
            ON CONFLICT(command_id) DO NOTHING
            RETURNING command_id
          `;

          if (reserved[0] === undefined) {
            const receiptRows = yield* sql<ReceiptRow>`
              SELECT command_id, squadron_id, command_type, accepted_at, result_seq
              FROM j5_a2a_comm_command_receipt
              WHERE command_id = ${command.commandId}
              LIMIT 1
            `;
            const row = receiptRows[0];
            if (row === undefined) {
              return yield* new A2AStorageError({ operation: "read replayed batch receipt" });
            }
            if (row.squadron_id !== command.squadronId) {
              return yield* new CommCommandConflictError({
                commandId: command.commandId,
                requestedSquadronId: command.squadronId,
                existingSquadronId: row.squadron_id,
              });
            }
            const eventRows = yield* sql<EventRow>`
              SELECT
                seq,
                squadron_id,
                kind,
                sender,
                receiver,
                exchange_id,
                correlation_id,
                payload,
                created_at
              FROM j5_a2a_comm_event
              WHERE squadron_id = ${command.squadronId} AND command_id = ${command.commandId}
              ORDER BY seq
            `;
            if (eventRows.length === 0) {
              return yield* new A2AStorageError({ operation: "read replayed batch events" });
            }
            return {
              receipt: yield* receiptFromRow(row),
              events: yield* Effect.forEach(eventRows, eventFromRow, { concurrency: 1 }),
              committed: false as const,
            };
          }

          const events: Array<StoredCommEvent> = [];
          for (const [index, candidate] of command.events.entries()) {
            if (
              (candidate.kind === "participant.joined" || candidate.kind === "participant.left") &&
              candidate.payload.participant.kind === "human"
            ) {
              return yield* new A2AStorageError({
                operation: "append host-global human as Squadron membership",
              });
            }
            const pending = decideAppendCommEvent({
              commandId: command.commandId,
              squadronId: command.squadronId,
              acceptedAt: command.acceptedAt,
              event: candidate,
            })[0];
            const seq = firstSeq + index;
            const payload = yield* encodeJson(pending.payload);
            yield* sql`
              INSERT INTO j5_a2a_comm_event (
                seq,
                squadron_id,
                kind,
                sender,
                receiver,
                exchange_id,
                correlation_id,
                payload,
                created_at,
                command_id
              ) VALUES (
                ${seq},
                ${pending.squadronId},
                ${pending.kind},
                ${pending.sender},
                ${pending.receiver},
                ${pending.exchangeId},
                ${pending.correlationId},
                ${payload},
                ${pending.createdAt},
                ${command.commandId}
              )
            `;
            const event = yield* decodeStoredEvent({ seq, ...pending });
            yield* applyMembership(event);
            yield* applyA2Projection(event, command.commandId);
            events.push(event);
          }
          return {
            receipt: yield* decodeReceipt({
              commandId: command.commandId,
              squadronId: command.squadronId,
              commandType: "comm.append",
              acceptedAt: command.acceptedAt,
              resultSeq,
            }),
            events,
            committed: true as const,
          };
        }),
      );
      if (result.committed) {
        for (const event of result.events) {
          yield* PubSub.publish(committed, event);
        }
      }
      return result;
    });

    return A2ALedger.of({
      createSquadron: (command) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO j5_a2a_squadron (id, name, created_at)
            VALUES (${command.squadron.id}, ${command.squadron.name}, ${command.squadron.createdAt})
            ON CONFLICT(id) DO NOTHING
          `;
          return yield* squadronFromRow(
            (yield* sql<SquadronRow>`
              SELECT id, name, created_at
              FROM j5_a2a_squadron
              WHERE id = ${command.squadron.id}
              LIMIT 1
            `)[0]!,
          );
        }).pipe(Effect.mapError(preserveDomainError("create squadron"))),
      listSquadrons: () =>
        Effect.gen(function* () {
          const rows = yield* sql<SquadronRow>`
            SELECT id, name, created_at FROM j5_a2a_squadron ORDER BY created_at, id
          `;
          return yield* Effect.forEach(rows, squadronFromRow, { concurrency: 1 });
        }).pipe(Effect.mapError(preserveDomainError("list squadrons"))),
      readSquadron: (squadronId) =>
        Effect.gen(function* () {
          const rows = yield* sql<SquadronRow>`
            SELECT id, name, created_at FROM j5_a2a_squadron WHERE id = ${squadronId} LIMIT 1
          `;
          const row = rows[0];
          if (row === undefined) return yield* new SquadronNotFoundError({ squadronId });
          return yield* squadronFromRow(row);
        }).pipe(Effect.mapError(preserveDomainError("read squadron"))),
      append: (command) =>
        appendPermit
          .withPermit(
            appendEventsEffect({
              commandId: command.commandId,
              squadronId: command.squadronId,
              acceptedAt: command.acceptedAt,
              events: [command.event],
            }).pipe(
              Effect.flatMap((result) => {
                const event = result.events[0];
                return event === undefined
                  ? Effect.fail(new A2AStorageError({ operation: "read single appended event" }))
                  : Effect.succeed({
                      receipt: result.receipt,
                      event,
                      committed: result.committed,
                    });
              }),
            ),
          )
          .pipe(Effect.mapError(preserveDomainError("append communication event"))),
      appendEvents: (command) =>
        appendPermit
          .withPermit(appendEventsEffect(command))
          .pipe(Effect.mapError(preserveDomainError("append communication events"))),
      readEvents: ({ squadronId, cursor, limit }) =>
        Effect.gen(function* () {
          yield* ensureSquadron(squadronId);
          const highWaterRows = yield* sql<{ readonly high_water: number }>`
            SELECT COALESCE(MAX(seq), 0) AS high_water
            FROM j5_a2a_comm_event
            WHERE squadron_id = ${squadronId}
          `;
          const highWater = highWaterRows[0]?.high_water ?? 0;
          const snapshotEnd = cursor.snapshotEnd ?? highWater;
          if (cursor.afterSeq > snapshotEnd || limit < 1 || !Number.isInteger(limit)) {
            return yield* new LedgerCursorError({
              squadronId,
              afterSeq: cursor.afterSeq,
              snapshotEnd,
            });
          }
          const rows = yield* sql<EventRow>`
            SELECT
              seq,
              squadron_id,
              kind,
              sender,
              receiver,
              exchange_id,
              correlation_id,
              payload,
              created_at
            FROM j5_a2a_comm_event
            WHERE squadron_id = ${squadronId}
              AND seq > ${cursor.afterSeq}
              AND seq <= ${snapshotEnd}
            ORDER BY seq
            LIMIT ${limit}
          `;
          const events = yield* Effect.forEach(rows, eventFromRow, { concurrency: 1 });
          let expectedSeq = cursor.afterSeq + 1;
          for (const event of events) {
            if (event.seq !== expectedSeq) {
              return yield* new LedgerGapError({
                squadronId,
                expectedSeq,
                actualSeq: event.seq,
              });
            }
            expectedSeq += 1;
          }
          if (events.length === 0 && cursor.afterSeq < snapshotEnd) {
            return yield* new LedgerGapError({ squadronId, expectedSeq, actualSeq: null });
          }
          const afterSeq = events.at(-1)?.seq ?? cursor.afterSeq;
          return {
            events,
            nextCursor: { afterSeq, snapshotEnd },
            complete: afterSeq === snapshotEnd,
          };
        }).pipe(Effect.mapError(preserveDomainError("read communication events"))),
      listMembership: (squadronId) =>
        listMembershipEffect(squadronId).pipe(
          Effect.mapError(preserveDomainError("list squadron membership")),
        ),
      findHistoricalAgentParticipantId: (input) =>
        findHistoricalAgentParticipantId(input).pipe(
          Effect.mapError(preserveDomainError("find historical agent participant")),
        ),
      rebuildMembership: (squadronId) =>
        appendPermit
          .withPermit(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* ensureSquadron(squadronId);
                yield* sql`DELETE FROM j5_a2a_squadron_membership WHERE squadron_id = ${squadronId}`;
                const rows = yield* sql<EventRow>`
                  SELECT
                    seq,
                    squadron_id,
                    kind,
                    sender,
                    receiver,
                    exchange_id,
                    correlation_id,
                    payload,
                    created_at
                  FROM j5_a2a_comm_event
                  WHERE squadron_id = ${squadronId}
                    AND kind IN ('participant.joined', 'participant.left')
                  ORDER BY seq
                `;
                for (const row of rows) {
                  yield* applyMembership(yield* eventFromRow(row));
                }
                return yield* listMembershipEffect(squadronId);
              }),
            ),
          )
          .pipe(Effect.mapError(preserveDomainError("rebuild squadron membership"))),
      subscribeCommitted: PubSub.subscribe(committed).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    });
  }),
);

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CommCommandReceipt,
  type AppendCommEventCommand,
  type CommEventPage,
  type CreateEpicCommand,
  Epic,
  type EpicId,
  type LedgerCursor,
  Membership,
  StoredCommEvent,
  participantId,
} from "./contracts.ts";
import { decideAppendCommEvent } from "./decider.ts";

export class A2AStorageError extends Schema.TaggedErrorClass<A2AStorageError>()("A2AStorageError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class EpicNotFoundError extends Schema.TaggedErrorClass<EpicNotFoundError>()(
  "EpicNotFoundError",
  { epicId: Schema.String },
) {}

export class CommCommandConflictError extends Schema.TaggedErrorClass<CommCommandConflictError>()(
  "CommCommandConflictError",
  {
    commandId: Schema.String,
    requestedEpicId: Schema.String,
    existingEpicId: Schema.String,
  },
) {}

export class LedgerCursorError extends Schema.TaggedErrorClass<LedgerCursorError>()(
  "LedgerCursorError",
  {
    epicId: Schema.String,
    afterSeq: Schema.Number,
    snapshotEnd: Schema.Number,
  },
) {}

export class LedgerGapError extends Schema.TaggedErrorClass<LedgerGapError>()("LedgerGapError", {
  epicId: Schema.String,
  expectedSeq: Schema.Number,
  actualSeq: Schema.NullOr(Schema.Number),
}) {}

export type A2ALedgerError =
  | A2AStorageError
  | EpicNotFoundError
  | CommCommandConflictError
  | LedgerCursorError
  | LedgerGapError;

const isA2ALedgerError = Schema.is(
  Schema.Union([
    A2AStorageError,
    EpicNotFoundError,
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

export interface A2ALedgerShape {
  readonly createEpic: (command: CreateEpicCommand) => Effect.Effect<Epic, A2ALedgerError>;
  readonly listEpics: () => Effect.Effect<ReadonlyArray<Epic>, A2ALedgerError>;
  readonly readEpic: (epicId: EpicId) => Effect.Effect<Epic, A2ALedgerError>;
  readonly append: (command: AppendCommEventCommand) => Effect.Effect<AppendResult, A2ALedgerError>;
  readonly readEvents: (input: {
    readonly epicId: EpicId;
    readonly cursor: LedgerCursor;
    readonly limit: number;
  }) => Effect.Effect<CommEventPage, A2ALedgerError>;
  readonly listMembership: (
    epicId: EpicId,
  ) => Effect.Effect<ReadonlyArray<Membership>, A2ALedgerError>;
  readonly rebuildMembership: (
    epicId: EpicId,
  ) => Effect.Effect<ReadonlyArray<Membership>, A2ALedgerError>;
  readonly subscribeCommitted: Effect.Effect<Stream.Stream<StoredCommEvent>, never, Scope.Scope>;
}

export class A2ALedger extends Context.Service<A2ALedger, A2ALedgerShape>()(
  "t3/j5/a2a/LedgerService/A2ALedger",
) {}

interface EpicRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
}

interface EventRow {
  readonly seq: number;
  readonly epic_id: string;
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
  readonly epic_id: string;
  readonly command_type: string;
  readonly accepted_at: string;
  readonly result_seq: number;
}

interface MembershipRow {
  readonly epic_id: string;
  readonly joined_seq: number;
  readonly updated_seq: number;
  readonly payload: string;
}

const decodeEpic = Schema.decodeUnknownEffect(Epic);
const decodeStoredEvent = Schema.decodeUnknownEffect(StoredCommEvent);
const decodeReceipt = Schema.decodeUnknownEffect(CommCommandReceipt);
const decodeMembership = Schema.decodeUnknownEffect(Membership);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const preserveDomainError =
  (operation: string) =>
  (cause: unknown): A2ALedgerError =>
    isA2ALedgerError(cause) ? cause : new A2AStorageError({ operation, cause });

const epicFromRow = (row: EpicRow) =>
  decodeEpic({ id: row.id, name: row.name, createdAt: row.created_at });

const eventFromRow = Effect.fn("j5.a2a.eventFromRow")(function* (row: EventRow) {
  return yield* decodeStoredEvent({
    seq: row.seq,
    epicId: row.epic_id,
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
    epicId: row.epic_id,
    commandType: row.command_type,
    acceptedAt: row.accepted_at,
    resultSeq: row.result_seq,
  });

const membershipFromRow = Effect.fn("j5.a2a.membershipFromRow")(function* (row: MembershipRow) {
  return yield* decodeMembership({
    epicId: row.epic_id,
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

    const ensureEpic = Effect.fn("j5.a2a.ensureEpic")(function* (epicId: EpicId) {
      const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM epic WHERE id = ${epicId} LIMIT 1
      `;
      if (rows[0] === undefined) {
        return yield* new EpicNotFoundError({ epicId });
      }
    });

    const applyMembership = Effect.fn("j5.a2a.applyMembership")(function* (event: StoredCommEvent) {
      if (event.kind !== "participant.joined" && event.kind !== "participant.left") return;
      const participant = event.payload.participant;
      const id = participantId(participant);
      if (event.kind === "participant.left") {
        yield* sql`
          DELETE FROM epic_membership
          WHERE epic_id = ${event.epicId} AND participant_id = ${id}
        `;
        return;
      }
      const payload = yield* encodeJson(participant);
      const threadId = participant.kind === "agent" ? participant.threadId : null;
      yield* sql`
        INSERT INTO epic_membership (
          epic_id,
          participant_id,
          participant_kind,
          thread_id,
          joined_seq,
          updated_seq,
          payload
        ) VALUES (
          ${event.epicId},
          ${id},
          ${participant.kind},
          ${threadId},
          ${event.seq},
          ${event.seq},
          ${payload}
        )
        ON CONFLICT(epic_id, participant_id)
        DO UPDATE SET
          participant_kind = excluded.participant_kind,
          thread_id = excluded.thread_id,
          joined_seq = excluded.joined_seq,
          updated_seq = excluded.updated_seq,
          payload = excluded.payload
      `;
    });

    const listMembershipEffect = Effect.fn("j5.a2a.listMembership")(function* (epicId: EpicId) {
      yield* ensureEpic(epicId);
      const rows = yield* sql<MembershipRow>`
        SELECT epic_id, joined_seq, updated_seq, payload
        FROM epic_membership
        WHERE epic_id = ${epicId}
        ORDER BY participant_id
      `;
      return yield* Effect.forEach(rows, membershipFromRow, { concurrency: 1 });
    });

    const appendEffect = Effect.fn("j5.a2a.append")(function* (command: AppendCommEventCommand) {
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* ensureEpic(command.epicId);
          const pending = decideAppendCommEvent(command)[0];
          const sequenceRows = yield* sql<{ readonly next_seq: number }>`
            SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
            FROM comm_event
            WHERE epic_id = ${command.epicId}
          `;
          const seq = sequenceRows[0]?.next_seq;
          if (seq === undefined) {
            return yield* new A2AStorageError({ operation: "allocate communication sequence" });
          }
          const reserved = yield* sql<{ readonly command_id: string }>`
            INSERT INTO comm_command_receipt (
              command_id,
              epic_id,
              command_type,
              accepted_at,
              result_seq
            ) VALUES (
              ${command.commandId},
              ${command.epicId},
              'comm.append',
              ${command.acceptedAt},
              ${seq}
            )
            ON CONFLICT(command_id) DO NOTHING
            RETURNING command_id
          `;

          if (reserved[0] === undefined) {
            const receiptRows = yield* sql<ReceiptRow>`
              SELECT command_id, epic_id, command_type, accepted_at, result_seq
              FROM comm_command_receipt
              WHERE command_id = ${command.commandId}
              LIMIT 1
            `;
            const row = receiptRows[0];
            if (row === undefined) {
              return yield* new A2AStorageError({
                operation: "read replayed command receipt",
              });
            }
            if (row.epic_id !== command.epicId) {
              return yield* new CommCommandConflictError({
                commandId: command.commandId,
                requestedEpicId: command.epicId,
                existingEpicId: row.epic_id,
              });
            }
            const eventRows = yield* sql<EventRow>`
              SELECT
                seq,
                epic_id,
                kind,
                sender,
                receiver,
                exchange_id,
                correlation_id,
                payload,
                created_at
              FROM comm_event
              WHERE epic_id = ${command.epicId} AND seq = ${row.result_seq}
              LIMIT 1
            `;
            const eventRow = eventRows[0];
            if (eventRow === undefined) {
              return yield* new A2AStorageError({
                operation: "read replayed command event",
              });
            }
            return {
              receipt: yield* receiptFromRow(row),
              event: yield* eventFromRow(eventRow),
              committed: false as const,
            };
          }

          const payload = yield* encodeJson(pending.payload);
          yield* sql`
            INSERT INTO comm_event (
              seq,
              epic_id,
              kind,
              sender,
              receiver,
              exchange_id,
              correlation_id,
              payload,
              created_at
            ) VALUES (
              ${seq},
              ${pending.epicId},
              ${pending.kind},
              ${pending.sender},
              ${pending.receiver},
              ${pending.exchangeId},
              ${pending.correlationId},
              ${payload},
              ${pending.createdAt}
            )
          `;
          const event = yield* decodeStoredEvent({ seq, ...pending });
          yield* applyMembership(event);
          const receipt = yield* decodeReceipt({
            commandId: command.commandId,
            epicId: command.epicId,
            commandType: "comm.append",
            acceptedAt: command.acceptedAt,
            resultSeq: seq,
          });
          return { receipt, event, committed: true as const };
        }),
      );
      if (result.committed) {
        yield* PubSub.publish(committed, result.event);
      }
      return result;
    });

    return A2ALedger.of({
      createEpic: (command) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO epic (id, name, created_at)
            VALUES (${command.epic.id}, ${command.epic.name}, ${command.epic.createdAt})
          `;
          return command.epic;
        }).pipe(Effect.mapError(preserveDomainError("create epic"))),
      listEpics: () =>
        Effect.gen(function* () {
          const rows = yield* sql<EpicRow>`
            SELECT id, name, created_at FROM epic ORDER BY created_at, id
          `;
          return yield* Effect.forEach(rows, epicFromRow, { concurrency: 1 });
        }).pipe(Effect.mapError(preserveDomainError("list epics"))),
      readEpic: (epicId) =>
        Effect.gen(function* () {
          const rows = yield* sql<EpicRow>`
            SELECT id, name, created_at FROM epic WHERE id = ${epicId} LIMIT 1
          `;
          const row = rows[0];
          if (row === undefined) return yield* new EpicNotFoundError({ epicId });
          return yield* epicFromRow(row);
        }).pipe(Effect.mapError(preserveDomainError("read epic"))),
      append: (command) =>
        appendPermit
          .withPermit(appendEffect(command))
          .pipe(Effect.mapError(preserveDomainError("append communication event"))),
      readEvents: ({ epicId, cursor, limit }) =>
        Effect.gen(function* () {
          yield* ensureEpic(epicId);
          const highWaterRows = yield* sql<{ readonly high_water: number }>`
            SELECT COALESCE(MAX(seq), 0) AS high_water
            FROM comm_event
            WHERE epic_id = ${epicId}
          `;
          const highWater = highWaterRows[0]?.high_water ?? 0;
          const snapshotEnd = cursor.snapshotEnd ?? highWater;
          if (cursor.afterSeq > snapshotEnd || limit < 1 || !Number.isInteger(limit)) {
            return yield* new LedgerCursorError({
              epicId,
              afterSeq: cursor.afterSeq,
              snapshotEnd,
            });
          }
          const rows = yield* sql<EventRow>`
            SELECT
              seq,
              epic_id,
              kind,
              sender,
              receiver,
              exchange_id,
              correlation_id,
              payload,
              created_at
            FROM comm_event
            WHERE epic_id = ${epicId}
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
                epicId,
                expectedSeq,
                actualSeq: event.seq,
              });
            }
            expectedSeq += 1;
          }
          if (events.length === 0 && cursor.afterSeq < snapshotEnd) {
            return yield* new LedgerGapError({ epicId, expectedSeq, actualSeq: null });
          }
          const afterSeq = events.at(-1)?.seq ?? cursor.afterSeq;
          return {
            events,
            nextCursor: { afterSeq, snapshotEnd },
            complete: afterSeq === snapshotEnd,
          };
        }).pipe(Effect.mapError(preserveDomainError("read communication events"))),
      listMembership: (epicId) =>
        listMembershipEffect(epicId).pipe(
          Effect.mapError(preserveDomainError("list epic membership")),
        ),
      rebuildMembership: (epicId) =>
        appendPermit
          .withPermit(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* ensureEpic(epicId);
                yield* sql`DELETE FROM epic_membership WHERE epic_id = ${epicId}`;
                const rows = yield* sql<EventRow>`
                  SELECT
                    seq,
                    epic_id,
                    kind,
                    sender,
                    receiver,
                    exchange_id,
                    correlation_id,
                    payload,
                    created_at
                  FROM comm_event
                  WHERE epic_id = ${epicId}
                    AND kind IN ('participant.joined', 'participant.left')
                  ORDER BY seq
                `;
                for (const row of rows) {
                  yield* applyMembership(yield* eventFromRow(row));
                }
                return yield* listMembershipEffect(epicId);
              }),
            ),
          )
          .pipe(Effect.mapError(preserveDomainError("rebuild epic membership"))),
      subscribeCommitted: PubSub.subscribe(committed).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    });
  }),
);

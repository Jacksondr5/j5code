import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  type AppendCommEventCommand,
  type CommCommandId,
  ParticipantId,
  SquadronId,
  type StoredCommEvent,
} from "./contracts.ts";
import {
  A2ALedger,
  type A2ALedgerError,
  A2ALedgerTransactionWriter,
  type AppendResult,
} from "./LedgerService.ts";

export interface RegisteredThreadHome {
  readonly squadronId: SquadronId;
  readonly participantId: ParticipantId;
}

export interface ThreadHomeLookup {
  readonly threadId: ThreadId;
  readonly home:
    | {
        readonly kind: "known";
        readonly squadron: { readonly id: SquadronId; readonly name: string };
      }
    | { readonly kind: "unknown" };
}

export interface RegisterAtCreationInput {
  readonly squadronId: SquadronId;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly commandId: CommCommandId;
}

export class A2AHomeNotFoundError extends Schema.TaggedErrorClass<A2AHomeNotFoundError>()(
  "A2AHomeNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no registered home squadron and is not an A2A participant. Provision it through a sanctioned creation wrapper or controlled test seed before retrying.`;
  }
}

export class A2AHomeConflictError extends Schema.TaggedErrorClass<A2AHomeConflictError>()(
  "A2AHomeConflictError",
  {
    threadId: Schema.String,
    existingSquadronId: Schema.String,
    requestedSquadronId: Schema.String,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} already has immutable home squadron ${this.existingSquadronId}; registration requested ${this.requestedSquadronId}. Keep the existing home; this registrar cannot select, move, or replace it.`;
  }
}

export class A2AHomeCommandConflictError extends Schema.TaggedErrorClass<A2AHomeCommandConflictError>()(
  "A2AHomeCommandConflictError",
  {
    commandId: Schema.String,
    requestedThreadId: Schema.String,
    requestedSquadronId: Schema.String,
  },
) {
  override get message(): string {
    return `Creation command ${this.commandId} is already bound to a different ledger event than thread ${this.requestedThreadId} in squadron ${this.requestedSquadronId}. Reuse the original creation inputs or issue a new command id.`;
  }
}

export type A2AHomeLookupError = SqlError | A2AHomeNotFoundError;

export type A2AHomeRegistrationError =
  | A2ALedgerError
  | SqlError
  | A2AHomeConflictError
  | A2AHomeCommandConflictError;

export interface A2AHomeRegistrarShape {
  readonly registerAtCreation: (
    input: RegisterAtCreationInput,
  ) => Effect.Effect<RegisteredThreadHome, A2AHomeRegistrationError>;
  readonly getHomeForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<RegisteredThreadHome, A2AHomeLookupError>;
  /**
   * Batch read for sidebar-visible thread sets. This reads immutable agent
   * joins only; native and unregistered threads remain explicitly unknown.
   */
  readonly getHomesForThreads: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyArray<ThreadHomeLookup>, SqlError>;
}

export class A2AHomeRegistrar extends Context.Service<A2AHomeRegistrar, A2AHomeRegistrarShape>()(
  "t3/j5/a2a/HomeRegistrar/A2AHomeRegistrar",
) {}

export interface RegisteredThreadHomeInTransaction {
  readonly home: RegisteredThreadHome;
  readonly committedEvents: ReadonlyArray<StoredCommEvent>;
}

/** Internal registration seam used only while the ledger write permit is already held. */
export interface A2AHomeRegistrationTransactionShape {
  readonly registerAtCreationInTransaction: (
    input: RegisterAtCreationInput,
  ) => Effect.Effect<RegisteredThreadHomeInTransaction, A2AHomeRegistrationError>;
}

export class A2AHomeRegistrationTransaction extends Context.Service<
  A2AHomeRegistrationTransaction,
  A2AHomeRegistrationTransactionShape
>()("t3/j5/a2a/HomeRegistrar/A2AHomeRegistrationTransaction") {}

interface HistoricalHomeRow {
  readonly home_squadron_id: string;
  readonly home_participant_id: string;
  readonly active_squadron_id: string | null;
  readonly active_participant_id: string | null;
  readonly is_retired: number;
}

interface ThreadHomeResolution {
  readonly home: RegisteredThreadHome;
  readonly activeMemberships: ReadonlyArray<RegisteredThreadHome>;
  readonly retired: boolean;
}

interface ThreadHomeLookupRow {
  readonly thread_id: string;
  readonly squadron_id: string;
  readonly squadron_name: string;
}

/** Leaves headroom under SQLite's bind-parameter ceiling for sidebar reads. */
export const THREAD_HOME_LOOKUP_BATCH_SIZE = 900;

const uniqueInFirstOccurrenceOrder = <Value>(values: ReadonlyArray<Value>) =>
  Array.from(new Set(values));

const batchesOf = <Value>(values: ReadonlyArray<Value>) => {
  const batches: Array<ReadonlyArray<Value>> = [];
  for (let index = 0; index < values.length; index += THREAD_HOME_LOOKUP_BATCH_SIZE) {
    batches.push(values.slice(index, index + THREAD_HOME_LOOKUP_BATCH_SIZE));
  }
  return batches;
};

export const participantIdForThread = (threadId: ThreadId) =>
  ParticipantId.make(`agent:j5:a2a:${threadId}`);

export const resolveThreadHome = Effect.fn("j5.a2a.resolveThreadHome")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.fn.Return<ThreadHomeResolution, A2AHomeLookupError> {
  const rows = yield* sql<HistoricalHomeRow>`
    SELECT
      event.squadron_id AS home_squadron_id,
      json_extract(event.payload, '$.participant.id') AS home_participant_id,
      membership.squadron_id AS active_squadron_id,
      membership.participant_id AS active_participant_id,
      EXISTS (
        SELECT 1
        FROM j5_a2a_comm_event AS retirement
        WHERE retirement.squadron_id = event.squadron_id
          AND retirement.seq > event.seq
          AND retirement.kind = 'participant.left'
          AND json_extract(retirement.payload, '$.participant.kind') = 'agent'
          AND json_extract(retirement.payload, '$.participant.id') =
            json_extract(event.payload, '$.participant.id')
          AND json_extract(retirement.payload, '$.participant.threadId') = ${threadId}
      ) AS is_retired
    FROM j5_a2a_comm_event AS event
    LEFT JOIN j5_a2a_squadron_membership AS membership
      ON membership.thread_id = ${threadId}
    WHERE event.kind = 'participant.joined'
      AND json_extract(event.payload, '$.participant.kind') = 'agent'
      AND json_extract(event.payload, '$.participant.threadId') = ${threadId}
    ORDER BY membership.squadron_id, membership.participant_id
  `;
  const first = rows[0];
  if (first === undefined) return yield* new A2AHomeNotFoundError({ threadId });
  const activeMemberships = Array.from(
    new Map(
      rows.flatMap((row) =>
        row.active_squadron_id === null || row.active_participant_id === null
          ? []
          : [
              [
                `${row.active_squadron_id}\u0000${row.active_participant_id}`,
                {
                  squadronId: row.active_squadron_id as SquadronId,
                  participantId: ParticipantId.make(row.active_participant_id),
                },
              ] as const,
            ],
      ),
    ).values(),
  );
  return {
    home: {
      squadronId: first.home_squadron_id as SquadronId,
      participantId: ParticipantId.make(first.home_participant_id),
    },
    activeMemberships,
    retired: first.is_retired === 1,
  };
});

const threadHomeRows = (sql: SqlClient.SqlClient, threadIds: ReadonlyArray<ThreadId>) =>
  sql<ThreadHomeLookupRow>`
    WITH ranked_homes AS (
      SELECT
        json_extract(event.payload, '$.participant.threadId') AS thread_id,
        squadron.id AS squadron_id,
        squadron.name AS squadron_name,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(event.payload, '$.participant.threadId')
          ORDER BY event.created_at ASC, event.squadron_id ASC, event.seq ASC
        ) AS home_rank
      FROM j5_a2a_comm_event AS event
      JOIN j5_a2a_squadron AS squadron ON squadron.id = event.squadron_id
      WHERE event.kind = 'participant.joined'
        AND json_extract(event.payload, '$.participant.kind') = 'agent'
        AND json_extract(event.payload, '$.participant.threadId') IN ${sql.in(threadIds)}
    )
    SELECT thread_id, squadron_id, squadron_name
    FROM ranked_homes
    WHERE home_rank = 1
  `;

const makeRegisterAtCreation = (input: {
  readonly getHomeForThread: A2AHomeRegistrarShape["getHomeForThread"];
  readonly readSquadron: A2ALedger["Service"]["readSquadron"];
  readonly append: (command: AppendCommEventCommand) => Effect.Effect<AppendResult, A2ALedgerError>;
}) =>
  Effect.fn("j5.a2a.registerAtCreation")(function* (registration: RegisterAtCreationInput) {
    const existing = yield* input
      .getHomeForThread(registration.threadId)
      .pipe(Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)));
    if (existing !== null && existing.squadronId !== registration.squadronId) {
      return yield* new A2AHomeConflictError({
        threadId: registration.threadId,
        existingSquadronId: existing.squadronId,
        requestedSquadronId: registration.squadronId,
      });
    }

    yield* input.readSquadron(registration.squadronId);
    // A historical home is ledger identity, not a value to re-derive after the
    // ID format changes. Only a thread without one mints the current format.
    const participantId = existing?.participantId ?? participantIdForThread(registration.threadId);
    const appendResult = yield* Effect.result(
      input.append({
        commandId: registration.commandId,
        squadronId: registration.squadronId,
        acceptedAt: registration.createdAt,
        event: {
          kind: "participant.joined",
          sender: null,
          receiver: participantId,
          exchangeId: null,
          correlationId: null,
          payload: {
            participant: {
              kind: "agent",
              id: participantId,
              threadId: registration.threadId,
            },
          },
          createdAt: registration.createdAt,
        },
      }),
    );
    if (appendResult._tag === "Failure") {
      const racedHome = yield* input
        .getHomeForThread(registration.threadId)
        .pipe(Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)));
      if (racedHome === null) return yield* appendResult.failure;
      if (racedHome.squadronId !== registration.squadronId) {
        return yield* new A2AHomeConflictError({
          threadId: registration.threadId,
          existingSquadronId: racedHome.squadronId,
          requestedSquadronId: registration.squadronId,
        });
      }
      return { home: racedHome, committedEvents: [] };
    }

    const event = appendResult.success.event;
    if (
      event.kind !== "participant.joined" ||
      event.squadronId !== registration.squadronId ||
      event.createdAt !== registration.createdAt ||
      event.payload.participant.kind !== "agent" ||
      event.payload.participant.threadId !== registration.threadId ||
      event.payload.participant.id !== participantId
    ) {
      return yield* new A2AHomeCommandConflictError({
        commandId: registration.commandId,
        requestedThreadId: registration.threadId,
        requestedSquadronId: registration.squadronId,
      });
    }
    return {
      home: { squadronId: registration.squadronId, participantId },
      committedEvents: appendResult.success.committed ? [event] : [],
    };
  });

export const layer: Layer.Layer<A2AHomeRegistrar, never, A2ALedger | SqlClient.SqlClient> =
  Layer.effect(
    A2AHomeRegistrar,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const sql = yield* SqlClient.SqlClient;
      const getHomeForThread: A2AHomeRegistrarShape["getHomeForThread"] = (threadId) =>
        resolveThreadHome(sql, threadId).pipe(Effect.map((resolution) => resolution.home));
      const getHomesForThreads: A2AHomeRegistrarShape["getHomesForThreads"] = (threadIds) =>
        Effect.gen(function* () {
          const uniqueThreadIds = uniqueInFirstOccurrenceOrder(threadIds);
          if (uniqueThreadIds.length === 0) return [];
          const rows: Array<ThreadHomeLookupRow> = [];
          for (const threadIdBatch of batchesOf(uniqueThreadIds)) {
            rows.push(...(yield* threadHomeRows(sql, threadIdBatch)));
          }
          const rowsByThread = new Map(rows.map((row) => [row.thread_id, row]));
          return uniqueThreadIds.map((threadId) => {
            const row = rowsByThread.get(threadId);
            return row === undefined
              ? ({ threadId, home: { kind: "unknown" } } satisfies ThreadHomeLookup)
              : ({
                  threadId,
                  home: {
                    kind: "known",
                    squadron: { id: SquadronId.make(row.squadron_id), name: row.squadron_name },
                  },
                } satisfies ThreadHomeLookup);
          });
        });

      const register = makeRegisterAtCreation({
        getHomeForThread,
        readSquadron: ledger.readSquadron,
        append: ledger.append,
      });
      return A2AHomeRegistrar.of({
        getHomeForThread,
        getHomesForThreads,
        registerAtCreation: (input) => register(input).pipe(Effect.map((result) => result.home)),
      });
    }),
  );

export const transactionLayer: Layer.Layer<
  A2AHomeRegistrationTransaction,
  never,
  A2ALedger | A2ALedgerTransactionWriter | SqlClient.SqlClient
> = Layer.effect(
  A2AHomeRegistrationTransaction,
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    const ledgerWriter = yield* A2ALedgerTransactionWriter;
    const sql = yield* SqlClient.SqlClient;
    const getHomeForThread: A2AHomeRegistrarShape["getHomeForThread"] = (threadId) =>
      resolveThreadHome(sql, threadId).pipe(Effect.map((resolution) => resolution.home));
    return A2AHomeRegistrationTransaction.of({
      registerAtCreationInTransaction: makeRegisterAtCreation({
        getHomeForThread,
        readSquadron: ledger.readSquadron,
        append: ledgerWriter.appendInTransaction,
      }),
    });
  }),
);

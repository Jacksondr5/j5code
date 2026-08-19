import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { type CommCommandId, ParticipantId, type SquadronId } from "./contracts.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";

export interface RegisteredThreadHome {
  readonly squadronId: SquadronId;
  readonly participantId: ParticipantId;
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

export class A2AAmbiguousHomeError extends Schema.TaggedErrorClass<A2AAmbiguousHomeError>()(
  "A2AAmbiguousHomeError",
  {
    threadId: Schema.String,
    homes: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} has conflicting historical homes (${this.homes.join(", ")}). The immutable-home invariant is already broken; repair the stored history before retrying.`;
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

export type A2AHomeLookupError = SqlError | A2AHomeNotFoundError | A2AAmbiguousHomeError;

export type A2AHomeRegistrationError =
  | A2ALedgerError
  | A2AHomeLookupError
  | A2AHomeConflictError
  | A2AHomeCommandConflictError;

export interface A2AHomeRegistrarShape {
  readonly registerAtCreation: (
    input: RegisterAtCreationInput,
  ) => Effect.Effect<RegisteredThreadHome, A2AHomeRegistrationError>;
  readonly getHomeForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<RegisteredThreadHome, A2AHomeLookupError>;
}

export class A2AHomeRegistrar extends Context.Service<A2AHomeRegistrar, A2AHomeRegistrarShape>()(
  "t3/j5/a2a/HomeRegistrar/A2AHomeRegistrar",
) {}

interface HistoricalHomeRow {
  readonly squadron_id: string;
  readonly participant_id: string;
}

const stablePart = (value: string) => encodeURIComponent(value);

export const participantIdForThread = (threadId: ThreadId) =>
  ParticipantId.make(`agent:j5:a2a:${stablePart(threadId)}`);

export const resolveThreadHome = Effect.fn("j5.a2a.resolveThreadHome")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<HistoricalHomeRow>`
    SELECT
      squadron_id,
      json_extract(payload, '$.participant.id') AS participant_id
    FROM j5_a2a_comm_event
    WHERE kind = 'participant.joined'
      AND json_extract(payload, '$.participant.kind') = 'agent'
      AND json_extract(payload, '$.participant.threadId') = ${threadId}
    ORDER BY squadron_id, seq
  `;
  const homes = Array.from(
    new Map(
      rows.map((row) => [
        `${row.squadron_id}\u0000${row.participant_id}`,
        {
          squadronId: row.squadron_id as SquadronId,
          participantId: ParticipantId.make(row.participant_id),
        },
      ]),
    ).values(),
  );
  if (homes.length === 0) return yield* new A2AHomeNotFoundError({ threadId });
  if (homes.length > 1) {
    return yield* new A2AAmbiguousHomeError({
      threadId,
      homes: homes.map((home) => `${home.squadronId}:${home.participantId}`),
    });
  }
  return homes[0]!;
});

export const layer: Layer.Layer<A2AHomeRegistrar, never, A2ALedger | SqlClient.SqlClient> =
  Layer.effect(
    A2AHomeRegistrar,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const sql = yield* SqlClient.SqlClient;

      const getHomeForThread: A2AHomeRegistrarShape["getHomeForThread"] = (threadId) =>
        resolveThreadHome(sql, threadId);

      const registerAtCreation: A2AHomeRegistrarShape["registerAtCreation"] = (input) =>
        Effect.gen(function* () {
          const existing = yield* getHomeForThread(input.threadId).pipe(
            Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)),
          );
          if (existing !== null) {
            if (existing.squadronId !== input.squadronId) {
              return yield* new A2AHomeConflictError({
                threadId: input.threadId,
                existingSquadronId: existing.squadronId,
                requestedSquadronId: input.squadronId,
              });
            }
          }

          yield* ledger.readSquadron(input.squadronId);
          const participantId = participantIdForThread(input.threadId);
          const appendResult = yield* Effect.result(
            ledger.append({
              commandId: input.commandId,
              squadronId: input.squadronId,
              acceptedAt: input.createdAt,
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
                    threadId: input.threadId,
                  },
                },
                createdAt: input.createdAt,
              },
            }),
          );
          if (appendResult._tag === "Failure") {
            const racedHome = yield* getHomeForThread(input.threadId).pipe(
              Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)),
            );
            if (racedHome === null) return yield* appendResult.failure;
            if (racedHome.squadronId !== input.squadronId) {
              return yield* new A2AHomeConflictError({
                threadId: input.threadId,
                existingSquadronId: racedHome.squadronId,
                requestedSquadronId: input.squadronId,
              });
            }
            return racedHome;
          }

          const event = appendResult.success.event;
          if (
            event.kind !== "participant.joined" ||
            event.squadronId !== input.squadronId ||
            event.createdAt !== input.createdAt ||
            event.payload.participant.kind !== "agent" ||
            event.payload.participant.threadId !== input.threadId ||
            event.payload.participant.id !== participantId
          ) {
            return yield* new A2AHomeCommandConflictError({
              commandId: input.commandId,
              requestedThreadId: input.threadId,
              requestedSquadronId: input.squadronId,
            });
          }
          return { squadronId: input.squadronId, participantId };
        });

      return A2AHomeRegistrar.of({ registerAtCreation, getHomeForThread });
    }),
  );

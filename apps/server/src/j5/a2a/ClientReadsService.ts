import { NonNegativeInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { type A2AHumanInboxError, A2AHumanInbox } from "./HumanInboxService.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const SquadronRead = Schema.Struct({
  id: SquadronId,
  name: Schema.String.check(
    Schema.makeFilter((name) => name.trim().length > 0 || "Squadron name must not be blank."),
  ),
});

export const ParticipantHome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("known"), squadron: SquadronRead }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);
export type ParticipantHome = typeof ParticipantHome.Type;

export const ParticipantHomeEntry = Schema.Struct({
  participantId: ParticipantId,
  home: ParticipantHome,
});
export type ParticipantHomeEntry = typeof ParticipantHomeEntry.Type;

/** Sidebar rows resolve visible participants in one bounded, total request. */
export const ParticipantHomesRequest = Schema.Struct({
  participantIds: Schema.Array(ParticipantId),
});
export type ParticipantHomesRequest = typeof ParticipantHomesRequest.Type;

export const ParticipantHomesResponse = Schema.Struct({
  entries: Schema.Array(ParticipantHomeEntry),
});
export type ParticipantHomesResponse = typeof ParticipantHomesResponse.Type;

export const DisplayIdentity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("known"), displayName: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);
export type DisplayIdentity = typeof DisplayIdentity.Type;

export const ParticipantIdentityEntry = Schema.Struct({
  participantId: ParticipantId,
  identity: DisplayIdentity,
});
export type ParticipantIdentityEntry = typeof ParticipantIdentityEntry.Type;

/** B3's batch request stays opaque: participant ids are neither trimmed nor normalized. */
export const ParticipantIdentitiesRequest = Schema.Struct({
  participantIds: Schema.Array(ParticipantId),
});
export type ParticipantIdentitiesRequest = typeof ParticipantIdentitiesRequest.Type;

export const ParticipantIdentitiesResponse = Schema.Struct({
  entries: Schema.Array(ParticipantIdentityEntry),
});
export type ParticipantIdentitiesResponse = typeof ParticipantIdentitiesResponse.Type;

export const OpenInboxCount = Schema.Struct({
  personId: ParticipantId,
  count: NonNegativeInt,
});
export type OpenInboxCount = typeof OpenInboxCount.Type;

export type ClientReadsError = SqlError | A2AHumanInboxError;

interface HistoricalHomeRow {
  readonly participant_id: string;
  readonly squadron_id: string;
  readonly squadron_name: string;
}

interface IdentityRow {
  readonly participant_id: string;
  readonly display_name: string | null;
}

interface OpenInboxCountRow {
  readonly count: number;
}

interface QueryPlanRow {
  readonly detail: string;
}

/** Leaves headroom under SQLite's bind-parameter ceiling for viewport-sized reads. */
export const CLIENT_READ_PARTICIPANT_BATCH_SIZE = 900;

const uniqueInFirstOccurrenceOrder = <Value>(values: ReadonlyArray<Value>) =>
  Array.from(new Set(values));

const batchesOf = <Value>(values: ReadonlyArray<Value>) => {
  const batches: Array<ReadonlyArray<Value>> = [];
  for (let index = 0; index < values.length; index += CLIENT_READ_PARTICIPANT_BATCH_SIZE) {
    batches.push(values.slice(index, index + CLIENT_READ_PARTICIPANT_BATCH_SIZE));
  }
  return batches;
};

const unknownHome = (): ParticipantHome => ({ kind: "unknown" });
const unknownIdentity = (): DisplayIdentity => ({ kind: "unknown" });

const toIdentity = (row: IdentityRow | undefined): DisplayIdentity => {
  if (row === undefined || row.display_name === null) return unknownIdentity();
  const displayName = row.display_name.trim();
  return displayName.length === 0
    ? unknownIdentity()
    : { kind: "known", displayName: TrimmedNonEmptyString.make(displayName) };
};

const participantHomeRows = (
  sql: SqlClient.SqlClient,
  participantIds: ReadonlyArray<ParticipantId>,
) =>
  sql<HistoricalHomeRow>`
    WITH ranked_homes AS (
      SELECT
        json_extract(event.payload, '$.participant.id') AS participant_id,
        squadron.id AS squadron_id,
        squadron.name AS squadron_name,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(event.payload, '$.participant.id')
          ORDER BY event.created_at ASC, event.squadron_id ASC, event.seq ASC
        ) AS home_rank
      FROM j5_a2a_comm_event AS event
      JOIN j5_a2a_squadron AS squadron ON squadron.id = event.squadron_id
      WHERE event.kind = 'participant.joined'
        AND json_extract(event.payload, '$.participant.kind') = 'agent'
        AND json_extract(event.payload, '$.participant.id') IN ${sql.in(participantIds)}
    )
    SELECT participant_id, squadron_id, squadron_name
    FROM ranked_homes
    WHERE home_rank = 1
  `;

const participantIdentityRows = (
  sql: SqlClient.SqlClient,
  participantIds: ReadonlyArray<ParticipantId>,
) =>
  sql<IdentityRow>`
    WITH ranked_identities AS (
      SELECT
        json_extract(event.payload, '$.participant.id') AS participant_id,
        thread.title AS display_name,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(event.payload, '$.participant.id')
          ORDER BY event.created_at ASC, event.squadron_id ASC, event.seq ASC
        ) AS history_rank
      FROM j5_a2a_comm_event AS event
      LEFT JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = json_extract(event.payload, '$.participant.threadId')
      WHERE event.kind = 'participant.joined'
        AND json_extract(event.payload, '$.participant.kind') = 'agent'
        AND json_extract(event.payload, '$.participant.id') IN ${sql.in(participantIds)}
    )
    SELECT participant_id, display_name
    FROM ranked_identities
    WHERE history_rank = 1
  `;

/** This exact statement is executed for count reads and compiled by the plan proof below. */
export const openInboxCountStatement = (sql: SqlClient.SqlClient, personId: ParticipantId) =>
  sql<OpenInboxCountRow>`
    SELECT COUNT(*) AS count
    FROM j5_a2a_human_inbox AS inbox
    JOIN j5_a2a_exchange AS exchange
      ON exchange.squadron_id = inbox.squadron_id
     AND exchange.exchange_id = inbox.exchange_id
    WHERE inbox.status = 'open'
      AND exchange.status = 'open'
      AND inbox.person_id = ${personId}
  `;

/** Test-facing plan hook that compiles the production count statement rather than a copy. */
export const explainOpenInboxCountStatement = (
  sql: SqlClient.SqlClient,
  personId: ParticipantId,
) => {
  const [statement, parameters] = openInboxCountStatement(sql, personId).compile();
  return sql.unsafe<QueryPlanRow>(`EXPLAIN QUERY PLAN ${statement}`, parameters);
};

export interface ClientReadsShape {
  /** Resolves a participant's immutable join-history home without consulting active membership. */
  readonly participantHomes: (
    participantIds: ReadonlyArray<ParticipantId>,
  ) => Effect.Effect<ReadonlyArray<ParticipantHomeEntry>, SqlError>;
  /** Batch-oriented, total identity resolution for B3 timelines and A4 inbox sender labels. */
  readonly participantIdentities: (
    input: ParticipantIdentitiesRequest,
  ) => Effect.Effect<ParticipantIdentitiesResponse, SqlError>;
  /** Counts with the same open inbox + open exchange predicate as A4's list. */
  readonly openInboxCount: (
    personId?: ParticipantId,
  ) => Effect.Effect<OpenInboxCount, ClientReadsError>;
}

export class ClientReadsService extends Context.Service<ClientReadsService, ClientReadsShape>()(
  "t3/j5/a2a/ClientReadsService",
) {}

export const layer: Layer.Layer<ClientReadsService, never, A2AHumanInbox | SqlClient.SqlClient> =
  Layer.effect(
    ClientReadsService,
    Effect.gen(function* () {
      const inbox = yield* A2AHumanInbox;
      const sql = yield* SqlClient.SqlClient;

      const participantHomes: ClientReadsShape["participantHomes"] = (participantIds) =>
        Effect.gen(function* () {
          const uniqueParticipantIds = uniqueInFirstOccurrenceOrder(participantIds);
          if (uniqueParticipantIds.length === 0) return [];
          const rows: Array<HistoricalHomeRow> = [];
          for (const participantIdBatch of batchesOf(uniqueParticipantIds)) {
            rows.push(...(yield* participantHomeRows(sql, participantIdBatch)));
          }
          const rowsByParticipant = Map.groupBy(rows, (row) => row.participant_id);
          return uniqueParticipantIds.map((participantId) => {
            const row = rowsByParticipant.get(participantId)?.[0];
            return {
              participantId,
              home:
                row === undefined
                  ? unknownHome()
                  : {
                      kind: "known" as const,
                      squadron: {
                        id: SquadronId.make(row.squadron_id),
                        name: row.squadron_name,
                      },
                    },
            } satisfies ParticipantHomeEntry;
          });
        });

      const participantIdentities: ClientReadsShape["participantIdentities"] = (input) =>
        Effect.gen(function* () {
          const uniqueParticipantIds = uniqueInFirstOccurrenceOrder(input.participantIds);
          if (uniqueParticipantIds.length === 0) return { entries: [] };
          const rows: Array<IdentityRow> = [];
          for (const participantIdBatch of batchesOf(uniqueParticipantIds)) {
            rows.push(...(yield* participantIdentityRows(sql, participantIdBatch)));
          }
          const rowsByParticipant = Map.groupBy(rows, (row) => row.participant_id);
          return {
            entries: uniqueParticipantIds.map((participantId) => {
              return {
                participantId,
                identity: toIdentity(rowsByParticipant.get(participantId)?.[0]),
              } satisfies ParticipantIdentityEntry;
            }),
          } satisfies ParticipantIdentitiesResponse;
        });

      const openInboxCount: ClientReadsShape["openInboxCount"] = (requestedPersonId) =>
        Effect.gen(function* () {
          const personId = yield* inbox.resolvePersonId(requestedPersonId);
          const rows = yield* openInboxCountStatement(sql, personId);
          return { personId, count: rows[0]?.count ?? 0 } satisfies OpenInboxCount;
        });

      return ClientReadsService.of({ participantHomes, participantIdentities, openInboxCount });
    }),
  );

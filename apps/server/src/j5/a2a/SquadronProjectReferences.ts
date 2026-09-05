import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { type SquadronId } from "./contracts.ts";

export interface SquadronProjectReference {
  readonly squadronId: SquadronId;
  readonly projectId: ProjectId;
  readonly ordinal: number;
  readonly createdAt: string;
}

export interface ReplaceSquadronProjectReferencesInput {
  readonly squadronId: SquadronId;
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly createdAt: string;
}

export class SquadronProjectReferenceSquadronNotFoundError extends Schema.TaggedErrorClass<SquadronProjectReferenceSquadronNotFoundError>()(
  "SquadronProjectReferenceSquadronNotFoundError",
  { squadronId: Schema.String },
) {}

export class DuplicateSquadronProjectReferenceError extends Schema.TaggedErrorClass<DuplicateSquadronProjectReferenceError>()(
  "DuplicateSquadronProjectReferenceError",
  { squadronId: Schema.String, projectId: Schema.String },
) {}

export type SquadronProjectReferenceError =
  | SqlError
  | SquadronProjectReferenceSquadronNotFoundError
  | DuplicateSquadronProjectReferenceError;

export interface SquadronProjectReferencesShape {
  readonly listForSquadron: (
    squadronId: SquadronId,
  ) => Effect.Effect<ReadonlyArray<SquadronProjectReference>, SquadronProjectReferenceError>;
  /**
   * Replaces the ordered resource list atomically. This is deliberately
   * list-shaped: DV1's exact-one cap belongs to the future creation command,
   * not to storage.
   */
  readonly replaceForSquadron: (
    input: ReplaceSquadronProjectReferencesInput,
  ) => Effect.Effect<ReadonlyArray<SquadronProjectReference>, SquadronProjectReferenceError>;
}

export class SquadronProjectReferences extends Context.Service<
  SquadronProjectReferences,
  SquadronProjectReferencesShape
>()("t3/j5/a2a/SquadronProjectReferences") {}

interface SquadronProjectReferenceRow {
  readonly squadron_id: string;
  readonly project_id: string;
  readonly ordinal: number;
  readonly created_at: string;
}

const referenceFromRow = (row: SquadronProjectReferenceRow): SquadronProjectReference => ({
  squadronId: row.squadron_id as SquadronId,
  projectId: ProjectId.make(row.project_id),
  ordinal: row.ordinal,
  createdAt: row.created_at,
});

export const layer: Layer.Layer<SquadronProjectReferences, never, SqlClient.SqlClient> =
  Layer.effect(
    SquadronProjectReferences,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const ensureSquadron = Effect.fn("j5.a2a.squadronProjectReferences.ensureSquadron")(
        function* (squadronId: SquadronId) {
          const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM j5_a2a_squadron WHERE id = ${squadronId} LIMIT 1
      `;
          if (rows[0] === undefined) {
            return yield* new SquadronProjectReferenceSquadronNotFoundError({ squadronId });
          }
        },
      );

      const listForSquadron = Effect.fn("j5.a2a.squadronProjectReferences.listForSquadron")(
        function* (squadronId: SquadronId) {
          yield* ensureSquadron(squadronId);
          const rows = yield* sql<SquadronProjectReferenceRow>`
        SELECT squadron_id, project_id, ordinal, created_at
        FROM j5_a2a_squadron_project_reference
        WHERE squadron_id = ${squadronId}
        ORDER BY ordinal, project_id
      `;
          return rows.map(referenceFromRow);
        },
      );

      const replaceForSquadron = Effect.fn("j5.a2a.squadronProjectReferences.replaceForSquadron")(
        function* (input: ReplaceSquadronProjectReferencesInput) {
          const seenProjectIds = new Set<string>();
          for (const projectId of input.projectIds) {
            if (seenProjectIds.has(projectId)) {
              return yield* new DuplicateSquadronProjectReferenceError({
                squadronId: input.squadronId,
                projectId,
              });
            }
            seenProjectIds.add(projectId);
          }

          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* ensureSquadron(input.squadronId);
              yield* sql`
            DELETE FROM j5_a2a_squadron_project_reference
            WHERE squadron_id = ${input.squadronId}
          `;
              for (const [ordinal, projectId] of input.projectIds.entries()) {
                yield* sql`
              INSERT INTO j5_a2a_squadron_project_reference (
                squadron_id,
                project_id,
                ordinal,
                created_at
              ) VALUES (
                ${input.squadronId},
                ${projectId},
                ${ordinal},
                ${input.createdAt}
              )
            `;
              }
              return yield* listForSquadron(input.squadronId);
            }),
          );
        },
      );

      return SquadronProjectReferences.of({ listForSquadron, replaceForSquadron });
    }),
  );

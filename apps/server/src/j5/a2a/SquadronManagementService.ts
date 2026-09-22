import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as ProjectService from "../../project/ProjectService.ts";
import { randomUuidV4 } from "../../orchestration-v2/RandomUuid.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import {
  SquadronProjectReferences,
  type SquadronProjectReferenceError,
} from "./SquadronProjectReferences.ts";
import { SquadronId, type Squadron } from "./contracts.ts";

export interface ManagedSquadron {
  readonly squadron: Squadron;
  readonly projectIds: ReadonlyArray<ProjectId>;
}

export interface CreateSquadronInput {
  readonly name: string;
  readonly projectId: ProjectId;
}

export interface RenameSquadronInput {
  readonly squadronId: SquadronId;
  readonly name: string;
}

export class SquadronNameRequiredError extends Schema.TaggedErrorClass<SquadronNameRequiredError>()(
  "SquadronNameRequiredError",
  {},
) {
  override get message(): string {
    return "A Squadron name is required.";
  }
}

export class SquadronProjectNotFoundError extends Schema.TaggedErrorClass<SquadronProjectNotFoundError>()(
  "SquadronProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} must already exist before it can be attached to a Squadron.`;
  }
}

/**
 * Only live state keeps a Squadron alive: unarchived agent members and Crews
 * that are still running. History never blocks, and a send-only machine
 * credential is not running work, so both are purged with the Squadron.
 */
export const SquadronDeleteBlockerKind = Schema.Literals(["agents", "crews"]);
export type SquadronDeleteBlockerKind = typeof SquadronDeleteBlockerKind.Type;

const blockerLabel = (kind: SquadronDeleteBlockerKind, count: number): string => {
  const plural = count === 1 ? "" : "s";
  switch (kind) {
    case "agents":
      return `${count} active agent${plural}`;
    case "crews":
      return `${count} running Crew${plural}`;
  }
};

/**
 * Every table with a foreign key onto `j5_a2a_squadron`, children before
 * parents. Three are ON DELETE RESTRICT (`j5_a2a_comm_event`,
 * `j5_a2a_comm_command_receipt`, `j5_a2a_placement_event`) and must be
 * deleted explicitly; the rest would cascade but are listed so the purge does
 * not depend on the foreign_keys pragma. A test compares this list with the
 * live schema so a new referencing table cannot be missed silently.
 */
export const SQUADRON_REFERENCING_TABLES: ReadonlyArray<{
  readonly table: string;
  readonly column: string;
}> = [
  { table: "j5_agent_crew_instance", column: "squadron_id" },
  { table: "j5_agent_crew_proposal", column: "squadron_id" },
  { table: "j5_a2a_human_inbox", column: "squadron_id" },
  { table: "j5_a2a_human_inbox_data", column: "origin_squadron_id" },
  { table: "j5_a2a_delivery", column: "squadron_id" },
  { table: "j5_a2a_exchange", column: "squadron_id" },
  { table: "j5_a2a_participant_placement", column: "squadron_id" },
  { table: "j5_a2a_placement_event", column: "squadron_id" },
  { table: "j5_a2a_machine_participant", column: "squadron_id" },
  { table: "j5_a2a_squadron_membership", column: "squadron_id" },
  { table: "j5_a2a_comm_command_receipt", column: "squadron_id" },
  { table: "j5_a2a_comm_event", column: "squadron_id" },
  { table: "j5_a2a_squadron_project_reference", column: "squadron_id" },
];

const joinBlockers = (labels: ReadonlyArray<string>): string =>
  labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

export class SquadronDeleteBlockedError extends Schema.TaggedErrorClass<SquadronDeleteBlockedError>()(
  "SquadronDeleteBlockedError",
  {
    squadronId: SquadronId,
    name: Schema.String,
    blockers: Schema.Array(
      Schema.Struct({ kind: SquadronDeleteBlockerKind, count: Schema.Number }),
    ),
  },
) {
  override get message(): string {
    const labels = this.blockers.map((blocker) => blockerLabel(blocker.kind, blocker.count));
    return `Squadron "${this.name}" cannot be deleted while it still has ${joinBlockers(labels)}.`;
  }
}

export type SquadronManagementError =
  | A2ALedgerError
  | ProjectService.ProjectServiceError
  | SquadronProjectReferenceError
  | SquadronNameRequiredError
  | SquadronProjectNotFoundError
  | SquadronDeleteBlockedError;

export interface SquadronManagementServiceShape {
  readonly list: () => Effect.Effect<ReadonlyArray<ManagedSquadron>, SquadronManagementError>;
  readonly create: (
    input: CreateSquadronInput,
  ) => Effect.Effect<ManagedSquadron, SquadronManagementError>;
  readonly rename: (
    input: RenameSquadronInput,
  ) => Effect.Effect<ManagedSquadron, SquadronManagementError>;
  readonly delete: (squadronId: SquadronId) => Effect.Effect<void, SquadronManagementError>;
}

/**
 * The creation surface owns the explicit name-plus-project command. Project
 * references are resources, never an alternate way to resolve a Squadron.
 */
export class SquadronManagementService extends Context.Service<
  SquadronManagementService,
  SquadronManagementServiceShape
>()("t3/j5/a2a/SquadronManagementService") {}

export const layer: Layer.Layer<
  SquadronManagementService,
  never,
  A2ALedger | ProjectService.ProjectService | SquadronProjectReferences | SqlClient.SqlClient
> = Layer.effect(
  SquadronManagementService,
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    const projects = yield* ProjectService.ProjectService;
    const references = yield* SquadronProjectReferences;
    const sql = yield* SqlClient.SqlClient;

    const list = Effect.fn("j5.a2a.squadronManagement.list")(function* () {
      const squadrons = yield* ledger.listSquadrons();
      return yield* Effect.forEach(
        squadrons,
        (squadron) =>
          references.listForSquadron(squadron.id).pipe(
            Effect.map((projectReferences) => ({
              squadron,
              projectIds: projectReferences.map((ref) => ref.projectId),
            })),
          ),
        { concurrency: 1 },
      );
    });

    const create = Effect.fn("j5.a2a.squadronManagement.create")(function* (
      input: CreateSquadronInput,
    ) {
      const name = input.name.trim();
      if (name.length === 0) return yield* new SquadronNameRequiredError();

      const project = yield* projects.getById(input.projectId);
      if (Option.isNone(project)) {
        return yield* new SquadronProjectNotFoundError({ projectId: input.projectId });
      }

      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const squadron = {
        id: SquadronId.make(`squadron:${yield* randomUuidV4}`),
        name,
        createdAt,
      } as const;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const created = yield* ledger.createSquadron({ squadron });
          const projectReferences = yield* references.replaceForSquadron({
            squadronId: created.id,
            projectIds: [input.projectId],
            createdAt,
          });
          return { squadron: created, projectIds: projectReferences.map((ref) => ref.projectId) };
        }),
      );
    });

    const rename = Effect.fn("j5.a2a.squadronManagement.rename")(function* (
      input: RenameSquadronInput,
    ) {
      const name = input.name.trim();
      if (name.length === 0) return yield* new SquadronNameRequiredError();
      const squadron = yield* ledger.renameSquadron({ squadronId: input.squadronId, name });
      const projectReferences = yield* references.listForSquadron(squadron.id);
      return { squadron, projectIds: projectReferences.map((ref) => ref.projectId) };
    });

    const countBlockers = (squadronId: SquadronId) => {
      const count = (query: Effect.Effect<ReadonlyArray<{ readonly count: number }>, SqlError>) =>
        query.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));
      return {
        agents: count(
          sql`SELECT COUNT(*) AS count FROM j5_a2a_squadron_membership WHERE squadron_id = ${squadronId} AND archived_at IS NULL`,
        ),
        crews: count(
          sql`SELECT COUNT(*) AS count FROM j5_agent_crew_instance WHERE squadron_id = ${squadronId} AND archived_at IS NULL`,
        ),
      } satisfies Record<SquadronDeleteBlockerKind, unknown>;
    };

    // Crew members hang off the crew instance, not the Squadron, so they go first.
    const purgeSquadronRows = (squadronId: SquadronId) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM j5_agent_crew_member WHERE crew_instance_id IN (
          SELECT id FROM j5_agent_crew_instance WHERE squadron_id = ${squadronId}
        )`;
        for (const { table, column } of SQUADRON_REFERENCING_TABLES) {
          yield* sql.unsafe(`DELETE FROM ${table} WHERE ${column} = ?`, [squadronId]);
        }
      });

    // Hard delete in one transaction. Live agents or running Crews refuse
    // with a named blocker; otherwise history and derived rows are purged and
    // threads that were homed here read as unknown-home afterwards.
    const remove = Effect.fn("j5.a2a.squadronManagement.delete")(function* (
      squadronId: SquadronId,
    ) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const squadron = yield* ledger.readSquadron(squadronId);
          const counts = countBlockers(squadronId);
          const blockers: Array<{ kind: SquadronDeleteBlockerKind; count: number }> = [];
          for (const kind of SquadronDeleteBlockerKind.literals) {
            const count = yield* counts[kind];
            if (count > 0) blockers.push({ kind, count });
          }
          if (blockers.length > 0) {
            return yield* new SquadronDeleteBlockedError({
              squadronId,
              name: squadron.name,
              blockers,
            });
          }
          yield* purgeSquadronRows(squadronId);
          yield* ledger.deleteSquadron(squadronId);
        }),
      );
    });

    return SquadronManagementService.of({ list, create, rename, delete: remove });
  }),
);

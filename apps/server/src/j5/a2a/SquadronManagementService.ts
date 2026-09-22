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
 * Rows that keep a Squadron alive. Membership, active Crews, and machine
 * participants are the user-facing reasons; the three history tables are the
 * `ON DELETE RESTRICT` foreign keys (`j5_a2a_comm_event`,
 * `j5_a2a_placement_event`, `j5_a2a_comm_command_receipt`) that would make the
 * DELETE fail anyway, surfaced here with a name instead of a constraint error.
 */
export const SquadronDeleteBlockerKind = Schema.Literals([
  "members",
  "crews",
  "machine_participants",
  "ledger_events",
  "placement_events",
  "command_receipts",
]);
export type SquadronDeleteBlockerKind = typeof SquadronDeleteBlockerKind.Type;

const blockerLabel = (kind: SquadronDeleteBlockerKind, count: number): string => {
  const plural = count === 1 ? "" : "s";
  switch (kind) {
    case "members":
      return `${count} member${plural}`;
    case "crews":
      return `${count} active Crew${plural}`;
    case "machine_participants":
      return `${count} machine participant${plural}`;
    case "ledger_events":
      return `${count} ledger event${plural}`;
    case "placement_events":
      return `${count} placement event${plural}`;
    case "command_receipts":
      return `${count} command receipt${plural}`;
  }
};

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

    const countRows = (squadronId: SquadronId) => {
      const count = (query: Effect.Effect<ReadonlyArray<{ readonly count: number }>, SqlError>) =>
        query.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));
      return {
        members: count(
          sql`SELECT COUNT(*) AS count FROM j5_a2a_squadron_membership WHERE squadron_id = ${squadronId}`,
        ),
        crews: count(
          sql`SELECT COUNT(*) AS count FROM j5_agent_crew_instance WHERE squadron_id = ${squadronId} AND archived_at IS NULL`,
        ),
        machine_participants: count(
          sql`SELECT COUNT(*) AS count FROM j5_a2a_machine_participant WHERE squadron_id = ${squadronId}`,
        ),
        ledger_events: count(
          sql`SELECT COUNT(*) AS count FROM j5_a2a_comm_event WHERE squadron_id = ${squadronId}`,
        ),
        placement_events: count(
          sql`SELECT COUNT(*) AS count FROM j5_a2a_placement_event WHERE squadron_id = ${squadronId}`,
        ),
        command_receipts: count(
          sql`SELECT COUNT(*) AS count FROM j5_a2a_comm_command_receipt WHERE squadron_id = ${squadronId}`,
        ),
      } satisfies Record<SquadronDeleteBlockerKind, unknown>;
    };

    // Hard delete in one transaction: RESTRICT-protected history is checked
    // first so the failure names the blocker, CASCADE tables go with the row.
    const remove = Effect.fn("j5.a2a.squadronManagement.delete")(function* (
      squadronId: SquadronId,
    ) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const squadron = yield* ledger.readSquadron(squadronId);
          const counts = countRows(squadronId);
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
          yield* ledger.deleteSquadron(squadronId);
        }),
      );
    });

    return SquadronManagementService.of({ list, create, rename, delete: remove });
  }),
);

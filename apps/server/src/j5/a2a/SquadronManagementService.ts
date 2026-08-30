import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

export type SquadronManagementError =
  | A2ALedgerError
  | ProjectService.ProjectServiceError
  | SquadronProjectReferenceError
  | SquadronNameRequiredError
  | SquadronProjectNotFoundError;

export interface SquadronManagementServiceShape {
  readonly list: () => Effect.Effect<ReadonlyArray<ManagedSquadron>, SquadronManagementError>;
  readonly create: (
    input: CreateSquadronInput,
  ) => Effect.Effect<ManagedSquadron, SquadronManagementError>;
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
          references
            .listForSquadron(squadron.id)
            .pipe(
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

    return SquadronManagementService.of({ list, create });
  }),
);

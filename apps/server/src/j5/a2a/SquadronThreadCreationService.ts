import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import { randomUuidV4 } from "../../orchestration-v2/RandomUuid.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import {
  A2AHomeConflictError,
  A2AHomeRegistrar,
  type A2AHomeRegistrationError,
  type A2AHomeLookupError,
  A2AHomeNotFoundError,
  type RegisteredThreadHome,
} from "./HomeRegistrar.ts";
import { A2ALedger } from "./LedgerService.ts";
import { CommCommandId, SquadronId } from "./contracts.ts";
import {
  SquadronProjectReferences,
  type SquadronProjectReferenceError,
} from "./SquadronProjectReferences.ts";

export interface SquadronThreadCreationInput {
  /**
   * The Squadron the launch sent or inherited. When absent, the thread
   * registers into its project's Squadron.
   */
  readonly squadronId?: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly createdAt: string;
}

export type SquadronThreadCreationResult = RegisteredThreadHome;

export class SquadronThreadCreationAmbiguousProjectError extends Schema.TaggedError<SquadronThreadCreationAmbiguousProjectError>()(
  "SquadronThreadCreationAmbiguousProjectError",
  {
    commandId: Schema.String,
    projectId: Schema.String,
    squadronIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Creation command ${this.commandId} sent no Squadron, and project ${this.projectId} is referenced by ${this.squadronIds.length} Squadrons. Send the Squadron to use.`;
  }
}

export class SquadronThreadCreationProjectUnavailableError extends Schema.TaggedError<SquadronThreadCreationProjectUnavailableError>()(
  "SquadronThreadCreationProjectUnavailableError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} is missing or deleted, so the thread was not given a Squadron in it.`;
  }
}

export class SquadronThreadCreationProjectReferenceError extends Schema.TaggedError<SquadronThreadCreationProjectReferenceError>()(
  "SquadronThreadCreationProjectReferenceError",
  {
    squadronId: Schema.String,
    projectId: Schema.String,
    referencedProjectIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Squadron ${this.squadronId} must explicitly reference exactly project ${this.projectId} before it can create this thread.`;
  }
}

export type SquadronThreadCreationError =
  | SquadronThreadCreationAmbiguousProjectError
  | SquadronThreadCreationProjectUnavailableError
  | SquadronThreadCreationProjectReferenceError
  | A2AHomeRegistrationError
  | SquadronProjectReferenceError
  | ProjectionRepositoryError
  | Schema.SchemaError;

export interface SquadronThreadCreationServiceShape {
  readonly registerAtDurableLaunch: (
    input: SquadronThreadCreationInput,
  ) => Effect.Effect<SquadronThreadCreationResult, SquadronThreadCreationError>;
  /**
   * Finds a pre-existing parent home for a creation edge. A legacy parent
   * without a Registrar entry remains explicitly native; this never chooses a
   * home from its project or current UI context.
   */
  readonly findRegisteredHome: (
    threadId: ThreadId,
  ) => Effect.Effect<
    RegisteredThreadHome | null,
    Exclude<A2AHomeLookupError, A2AHomeNotFoundError>
  >;
}

/**
 * Sanctioned J5 creation engine. ThreadLaunch calls this only after durable
 * thread creation; an attach failure leaves that named thread intact so a
 * replay can register its immutable home with the exact same command id.
 */
export class SquadronThreadCreationService extends Context.Service<
  SquadronThreadCreationService,
  SquadronThreadCreationServiceShape
>()("t3/j5/a2a/SquadronThreadCreationService") {}

const decodeSquadronId = Schema.decodeUnknownEffect(SquadronId);

export const registrationCommandIdForCreation = (commandId: string) =>
  CommCommandId.make(`command:j5:a2a:thread-creation:${encodeURIComponent(commandId)}`);

export const layer: Layer.Layer<
  SquadronThreadCreationService,
  never,
  | A2AHomeRegistrar
  | A2ALedger
  | ProjectionProjectRepository
  | SquadronProjectReferences
  | SqlClient.SqlClient
> = Layer.effect(
  SquadronThreadCreationService,
  Effect.gen(function* () {
    const registrar = yield* A2AHomeRegistrar;
    const ledger = yield* A2ALedger;
    // The projection is read directly: ProjectService needs the orchestration
    // runtime, which is itself built on this layer.
    const projects = yield* ProjectionProjectRepository;
    const projectReferences = yield* SquadronProjectReferences;
    const sql = yield* SqlClient.SqlClient;

    const findRegisteredHome: SquadronThreadCreationServiceShape["findRegisteredHome"] = (
      threadId,
    ) =>
      registrar
        .getHomeForThread(threadId)
        .pipe(Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)));

    /**
     * The home of a launch that sent no Squadron: the one Squadron that
     * references its project, or a new one named after the project when none
     * does. Several are refused, because nothing says which one was meant.
     */
    const resolveProjectSquadron = Effect.fn(
      "j5.a2a.squadronThreadCreation.resolveProjectSquadron",
    )(function* (input: SquadronThreadCreationInput) {
      const references = yield* projectReferences.listForProject(input.projectId);
      const only = references[0];
      if (references.length > 1) {
        return yield* new SquadronThreadCreationAmbiguousProjectError({
          commandId: input.commandId,
          projectId: input.projectId,
          squadronIds: references.map((reference) => reference.squadronId),
        });
      }

      const project = yield* projects.getById({ projectId: input.projectId });
      if (Option.isNone(project) || project.value.deletedAt !== null) {
        return yield* new SquadronThreadCreationProjectUnavailableError({
          projectId: input.projectId,
        });
      }
      if (only !== undefined) return only.squadronId;
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const created = yield* ledger.createSquadron({
        squadron: {
          id: SquadronId.make(`squadron:${yield* randomUuidV4}`),
          // Project commands only accept a non-blank title; the Squadron
          // table refuses a blank name if one ever got through.
          name: project.value.title,
          createdAt,
        },
      });
      yield* projectReferences.replaceForSquadron({
        squadronId: created.id,
        projectIds: [input.projectId],
        createdAt,
      });
      return created.id;
    });

    const findRegisteredHome: SquadronThreadCreationServiceShape["findRegisteredHome"] = (
      threadId,
    ) =>
      registrar
        .getHomeForThread(threadId)
        .pipe(Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)));

    const registerAtDurableLaunch: SquadronThreadCreationServiceShape["registerAtDurableLaunch"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const register = (squadronId: SquadronId) =>
          registrar.registerAtCreation({
            squadronId,
            threadId: input.threadId,
            createdAt: input.createdAt,
            commandId: registrationCommandIdForCreation(input.commandId),
          });

        if (input.squadronId === undefined) {
          // A replay keeps the home its first attempt registered, even if the
          // project has gained another Squadron since.
          const existing = yield* findRegisteredHome(input.threadId);
          if (existing !== null) return yield* register(existing.squadronId);
          // The SQL client runs one transaction at a time, so two launches into
          // a project with no Squadron create one between them. That covers
          // only this path: a person creating a Squadron for the same project
          // through the create route at the same moment can still produce two.
          return yield* register(yield* sql.withTransaction(resolveProjectSquadron(input)));
        }
        const squadronId = yield* decodeSquadronId(input.squadronId);

        // A J5 spawn or Crew seat in a new worktree records its home and placement first, then
        // hands the thread to ThreadLaunch, which lands here. That home was admitted by the spawn, which
        // never required the one-project reference below, so it is returned as it stands; without
        // this, a second join would be appended under this creation's command id.
        const existing = yield* findRegisteredHome(input.threadId);
        if (existing !== null) {
          if (existing.squadronId === squadronId) return existing;
          return yield* new A2AHomeConflictError({
            threadId: input.threadId,
            existingSquadronId: existing.squadronId,
            requestedSquadronId: squadronId,
          });
        }

        const references = yield* projectReferences.listForSquadron(squadronId);
        const referencedProjectIds = references.map((reference) => reference.projectId);
        if (referencedProjectIds.length !== 1 || referencedProjectIds[0] !== input.projectId) {
          return yield* new SquadronThreadCreationProjectReferenceError({
            squadronId,
            projectId: input.projectId,
            referencedProjectIds,
          });
        }

        return yield* register(squadronId);
      });

    return SquadronThreadCreationService.of({ registerAtDurableLaunch, findRegisteredHome });
  }),
);

import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import {
  A2AHomeRegistrar,
  type A2AHomeRegistrationError,
  type RegisteredThreadHome,
} from "./HomeRegistrar.ts";
import { CommCommandId, type SquadronId } from "./contracts.ts";
import {
  SquadronProjectReferences,
  type SquadronProjectReferenceError,
} from "./SquadronProjectReferences.ts";

export interface SquadronThreadCreationInput {
  /**
   * The edge contract makes this optional for backwards compatibility. The J5
   * boundary makes it mandatory: creation without an explicit Squadron fails.
   */
  readonly squadronId?: SquadronId;
  readonly launch: ThreadLaunch.ThreadLaunchInput;
}

export interface SquadronThreadCreationResult {
  readonly launch: ThreadLaunch.ThreadLaunchResult;
  readonly home: RegisteredThreadHome;
}

export class SquadronThreadCreationMissingSquadronError extends Schema.TaggedErrorClass<SquadronThreadCreationMissingSquadronError>()(
  "SquadronThreadCreationMissingSquadronError",
  { commandId: Schema.String },
) {
  override get message(): string {
    return `Creation command ${this.commandId} requires an explicit existing Squadron.`;
  }
}

export class SquadronThreadCreationProjectReferenceError extends Schema.TaggedErrorClass<SquadronThreadCreationProjectReferenceError>()(
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
  | SquadronThreadCreationMissingSquadronError
  | SquadronThreadCreationProjectReferenceError
  | A2AHomeRegistrationError
  | SquadronProjectReferenceError
  | ThreadLaunch.ThreadLaunchError;

export interface SquadronThreadCreationServiceShape {
  readonly create: (
    input: SquadronThreadCreationInput,
  ) => Effect.Effect<SquadronThreadCreationResult, SquadronThreadCreationError>;
}

/**
 * Sanctioned J5 creation choreography. It deliberately wraps the canonical
 * launch service instead of reconstructing thread creation from lower-level
 * commands, then registers the immutable home in the same SQL transaction.
 */
export class SquadronThreadCreationService extends Context.Service<
  SquadronThreadCreationService,
  SquadronThreadCreationServiceShape
>()("t3/j5/a2a/SquadronThreadCreationService") {}

export const registrationCommandIdForCreation = (commandId: string) =>
  CommCommandId.make(`command:j5:a2a:thread-creation:${encodeURIComponent(commandId)}`);

export const layer: Layer.Layer<
  SquadronThreadCreationService,
  never,
  | SqlClient.SqlClient
  | ThreadLaunch.ThreadLaunchService
  | A2AHomeRegistrar
  | SquadronProjectReferences
> = Layer.effect(
  SquadronThreadCreationService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const launcher = yield* ThreadLaunch.ThreadLaunchService;
    const registrar = yield* A2AHomeRegistrar;
    const projectReferences = yield* SquadronProjectReferences;

    const create: SquadronThreadCreationServiceShape["create"] = (input) =>
      Effect.gen(function* () {
        const squadronId = input.squadronId;
        if (squadronId === undefined) {
          return yield* new SquadronThreadCreationMissingSquadronError({
            commandId: input.launch.commandId,
          });
        }

        const references = yield* projectReferences.listForSquadron(squadronId);
        const referencedProjectIds = references.map((reference) => reference.projectId);
        if (
          referencedProjectIds.length !== 1 ||
          referencedProjectIds[0] !== input.launch.projectId
        ) {
          return yield* new SquadronThreadCreationProjectReferenceError({
            squadronId,
            projectId: input.launch.projectId,
            referencedProjectIds,
          });
        }

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const launch = yield* launcher.launch(input.launch);
            const home = yield* registrar.registerAtCreation({
              squadronId,
              threadId: launch.threadId,
              // The launch projection persists this instant. Replays therefore
              // reproduce the registrar's command and event inputs exactly.
              createdAt: DateTime.formatIso(launch.projection.thread.createdAt),
              commandId: registrationCommandIdForCreation(input.launch.commandId),
            });
            return { launch, home };
          }),
        );
      });

    return SquadronThreadCreationService.of({ create });
  }),
);

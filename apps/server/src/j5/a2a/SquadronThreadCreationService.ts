import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  A2AHomeRegistrar,
  type A2AHomeRegistrationError,
  type RegisteredThreadHome,
} from "./HomeRegistrar.ts";
import { CommCommandId, SquadronId } from "./contracts.ts";
import {
  SquadronProjectReferences,
  type SquadronProjectReferenceError,
} from "./SquadronProjectReferences.ts";

export interface SquadronThreadCreationInput {
  /**
   * The edge contract makes this optional for backwards compatibility. The J5
   * boundary makes it mandatory: creation without an explicit Squadron fails.
   */
  readonly squadronId?: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly createdAt: string;
}

export type SquadronThreadCreationResult = RegisteredThreadHome;

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
  | Schema.SchemaError;

export interface SquadronThreadCreationServiceShape {
  readonly registerAtDurableLaunch: (
    input: SquadronThreadCreationInput,
  ) => Effect.Effect<SquadronThreadCreationResult, SquadronThreadCreationError>;
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

export const registrationCommandIdForCreation = (commandId: string) =>
  CommCommandId.make(`command:j5:a2a:thread-creation:${encodeURIComponent(commandId)}`);

export const layer: Layer.Layer<
  SquadronThreadCreationService,
  never,
  A2AHomeRegistrar | SquadronProjectReferences
> = Layer.effect(
  SquadronThreadCreationService,
  Effect.gen(function* () {
    const registrar = yield* A2AHomeRegistrar;
    const projectReferences = yield* SquadronProjectReferences;

    const registerAtDurableLaunch: SquadronThreadCreationServiceShape["registerAtDurableLaunch"] = (
      input,
    ) =>
      Effect.gen(function* () {
        if (input.squadronId === undefined) {
          return yield* new SquadronThreadCreationMissingSquadronError({
            commandId: input.commandId,
          });
        }
        const squadronId = yield* Schema.decodeUnknownEffect(SquadronId)(input.squadronId);

        const references = yield* projectReferences.listForSquadron(squadronId);
        const referencedProjectIds = references.map((reference) => reference.projectId);
        if (referencedProjectIds.length !== 1 || referencedProjectIds[0] !== input.projectId) {
          return yield* new SquadronThreadCreationProjectReferenceError({
            squadronId,
            projectId: input.projectId,
            referencedProjectIds,
          });
        }

        return yield* registrar.registerAtCreation({
          squadronId,
          threadId: input.threadId,
          createdAt: input.createdAt,
          commandId: registrationCommandIdForCreation(input.commandId),
        });
      });

    return SquadronThreadCreationService.of({ registerAtDurableLaunch });
  }),
);

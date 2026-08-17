import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadLifecycle from "../../orchestration-v2/ThreadLifecycleService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type { EpicId, ParticipantId } from "./contracts.ts";
import type { ParticipantPlacementView, PlacementCommandId } from "./placementContracts.ts";
import {
  type PlacementError,
  ParticipantPlacementService,
  type ParticipantPlacementServiceShape,
} from "./PlacementService.ts";

export const PlacementCascadeOperation = Schema.Literals(["stop", "archive"]);
export type PlacementCascadeOperation = typeof PlacementCascadeOperation.Type;

export interface PlacementCascadeInput {
  readonly commandId: PlacementCommandId;
  readonly epicId: EpicId;
  readonly participantId: ParticipantId;
}

export interface PlacementCascadeRow {
  readonly participantId: ParticipantId;
  readonly threadId: ThreadId;
  readonly outcome:
    | "interrupt_requested"
    | "no_active_run"
    | "already_terminal"
    | "archived"
    | "already_archived";
}

export class PlacementCascadeDispatchError extends Schema.TaggedErrorClass<PlacementCascadeDispatchError>()(
  "PlacementCascadeDispatchError",
  {
    operation: PlacementCascadeOperation,
    participantId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Placement cascade ${this.operation} state failed for participant ${this.participantId} on thread ${this.threadId}; descendants already processed remain settled.`;
  }
}

export type PlacementCascadeError = PlacementError | PlacementCascadeDispatchError;

type AgentParticipantPlacementView = Omit<ParticipantPlacementView, "participant" | "threadId"> & {
  readonly participant: Extract<ParticipantPlacementView["participant"], { kind: "agent" }>;
  readonly threadId: ThreadId;
};

/**
 * Runs one per-thread primitive over the J5 placement subtree in leaves-first
 * order. Provenance is deliberately absent from traversal: siblings and forks
 * do not move together unless their mutable placement pointers say they do.
 */
export const runPlacementCascade = <A, E>(input: {
  readonly placement: ParticipantPlacementServiceShape;
  readonly epicId: EpicId;
  readonly participantId: ParticipantId;
  readonly operation: (participant: AgentParticipantPlacementView) => Effect.Effect<A, E>;
}): Effect.Effect<ReadonlyArray<A>, PlacementError | E> =>
  input.placement.listSubtree({ epicId: input.epicId, participantId: input.participantId }).pipe(
    Effect.flatMap((participants) =>
      Effect.forEach(
        participants.filter(
          (participant): participant is AgentParticipantPlacementView =>
            participant.participant.kind === "agent" && participant.threadId !== null,
        ),
        input.operation,
        { concurrency: 1 },
      ),
    ),
  );

export interface PlacementCascadeServiceShape {
  readonly stop: (
    input: PlacementCascadeInput,
  ) => Effect.Effect<ReadonlyArray<PlacementCascadeRow>, PlacementCascadeError>;
  readonly archive: (
    input: PlacementCascadeInput,
  ) => Effect.Effect<ReadonlyArray<PlacementCascadeRow>, PlacementCascadeError>;
}

export class PlacementCascadeService extends Context.Service<
  PlacementCascadeService,
  PlacementCascadeServiceShape
>()("t3/j5/a2a/PlacementCascadeService") {}

export const layer: Layer.Layer<
  PlacementCascadeService,
  never,
  | ParticipantPlacementService
  | ThreadManagement.ThreadManagementService
  | ThreadLifecycle.ThreadLifecycleService
> = Layer.effect(
  PlacementCascadeService,
  Effect.gen(function* () {
    const placement = yield* ParticipantPlacementService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const lifecycle = yield* ThreadLifecycle.ThreadLifecycleService;

    const commandId = (
      input: PlacementCascadeInput,
      operation: PlacementCascadeOperation,
      threadId: ThreadId,
    ) => CommandId.make(`${input.commandId}:${operation}:${threadId}`);

    const stop: PlacementCascadeServiceShape["stop"] = (input) =>
      runPlacementCascade({
        placement,
        epicId: input.epicId,
        participantId: input.participantId,
        operation: (participant) =>
          Effect.gen(function* () {
            const projection = yield* threads.getThreadProjection(participant.threadId);
            const result = yield* threads.interruptThread({
              projectId: projection.thread.projectId,
              commandId: commandId(input, "stop", participant.threadId),
              threadId: participant.threadId,
              reason: `Placement cascade requested by ${input.participantId}.`,
            });
            return {
              participantId: participant.participantId,
              threadId: participant.threadId,
              outcome: result.type,
            } satisfies PlacementCascadeRow;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new PlacementCascadeDispatchError({
                  operation: "stop",
                  participantId: participant.participantId,
                  threadId: participant.threadId,
                  cause,
                }),
            ),
          ),
      });

    const archive: PlacementCascadeServiceShape["archive"] = (input) =>
      runPlacementCascade({
        placement,
        epicId: input.epicId,
        participantId: input.participantId,
        operation: (participant) =>
          Effect.gen(function* () {
            const projection = yield* threads.getThreadProjection(participant.threadId);
            if (projection.thread.archivedAt !== null) {
              return {
                participantId: participant.participantId,
                threadId: participant.threadId,
                outcome: "already_archived",
              } satisfies PlacementCascadeRow;
            }
            yield* lifecycle.archive({
              commandId: commandId(input, "archive", participant.threadId),
              threadId: participant.threadId,
            });
            return {
              participantId: participant.participantId,
              threadId: participant.threadId,
              outcome: "archived",
            } satisfies PlacementCascadeRow;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new PlacementCascadeDispatchError({
                  operation: "archive",
                  participantId: participant.participantId,
                  threadId: participant.threadId,
                  cause,
                }),
            ),
          ),
      });

    return PlacementCascadeService.of({ stop, archive });
  }),
);

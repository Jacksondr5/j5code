import type { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import type { ParticipantId, SquadronId } from "./contracts.ts";

export type CrewSeatStopResult = "interrupt_requested" | "already_idle" | "archived";

export interface StopCrewInput {
  /** The Captain calling over MCP, or null when a person stops the Crew from the app. */
  readonly callerParticipantId: ParticipantId | null;
  /** The caller's Squadron when an agent calls; the Crew must live there. */
  readonly squadronId: SquadronId | null;
  readonly crewInstanceId: string;
  /** Deterministic per seat so a retried stop cannot interrupt twice. */
  readonly commandIds: (seatName: string) => { readonly interruptCommandId: CommandId };
}

export interface StopCrewOutcome {
  readonly crewInstanceId: string;
  readonly members: ReadonlyArray<{
    readonly seatName: string;
    readonly participantId: ParticipantId;
    readonly result: CrewSeatStopResult;
  }>;
}

export class CrewStopNotFoundError extends Data.TaggedError("CrewStopNotFoundError")<{
  readonly crewInstanceId: string;
}> {
  override get message() {
    return `Crew ${this.crewInstanceId} does not exist.`;
  }
}

export class CrewStopRequestError extends Data.TaggedError("CrewStopRequestError")<{
  readonly detail: string;
  readonly nextStep: string;
}> {
  override get message() {
    return this.detail;
  }
}

export class CrewStopOperationError extends Data.TaggedError("CrewStopOperationError")<{
  readonly phase: string;
  readonly seatName: string | null;
  readonly cause: unknown;
}> {
  override get message() {
    return `Stopping the crew failed while ${this.phase}${this.seatName === null ? "" : ` (seat ${this.seatName})`}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

export type CrewStopError = CrewStopNotFoundError | CrewStopRequestError | CrewStopOperationError;

export interface CrewStopServiceShape {
  /**
   * Interrupt every seat with a running turn; idle seats are untouched, nothing settles or
   * archives, and the Crew stays live so any seat can be messaged again. Only the Captain or a
   * person may stop a Crew: stopping is a controller's act, and a member owns nothing about its
   * crewmates' turns (Bryant, 2026-09-14).
   */
  readonly stop: (input: StopCrewInput) => Effect.Effect<StopCrewOutcome, CrewStopError>;
}

export class CrewStopService extends Context.Service<CrewStopService, CrewStopServiceShape>()(
  "t3/j5/a2a/CrewStopService",
) {}

export const layer = Layer.effect(
  CrewStopService,
  Effect.gen(function* () {
    const crews = yield* AgentCrewInstanceService;
    const threads = yield* ThreadManagementService;

    const stop: CrewStopServiceShape["stop"] = (input) =>
      Effect.gen(function* () {
        const instance = yield* crews
          .read(input.crewInstanceId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new CrewStopOperationError({ phase: "reading the crew", seatName: null, cause }),
            ),
          );
        if (instance === null)
          return yield* new CrewStopNotFoundError({ crewInstanceId: input.crewInstanceId });
        if (input.squadronId !== null && instance.squadronId !== input.squadronId)
          return yield* new CrewStopRequestError({
            detail: `Crew ${instance.id} lives in Squadron ${instance.squadronId}, not ${input.squadronId}.`,
            nextStep: `Retry with squadron_id=${instance.squadronId}.`,
          });
        if (
          input.callerParticipantId !== null &&
          instance.captainParticipantId !== input.callerParticipantId
        )
          return yield* new CrewStopRequestError({
            detail: `Crew ${instance.id} is commanded by ${instance.captainParticipantId}; only its Captain or the human may stop it.`,
            nextStep:
              "Ask the Captain with send_message, or stop one agent you command with stop_agent.",
          });
        if (instance.archivedAt !== null)
          return yield* new CrewStopRequestError({
            detail: `Crew ${instance.id} was archived at ${instance.archivedAt}; there is nothing running to stop.`,
            nextStep: "Nothing to do.",
          });
        const members = yield* Effect.forEach(
          instance.members,
          (member) =>
            Effect.gen(function* () {
              const projection = yield* threads.getThreadProjection(member.threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new CrewStopOperationError({
                      phase: "reading a seat",
                      seatName: member.seatName,
                      cause,
                    }),
                ),
              );
              if (projection.thread.archivedAt !== null)
                return {
                  seatName: member.seatName,
                  participantId: member.participantId,
                  result: "archived" as const,
                };
              const result = yield* threads
                .interruptThread({
                  projectId: projection.thread.projectId,
                  commandId: input.commandIds(member.seatName).interruptCommandId,
                  threadId: member.threadId,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new CrewStopOperationError({
                        phase: "interrupting a seat",
                        seatName: member.seatName,
                        cause,
                      }),
                  ),
                );
              return {
                seatName: member.seatName,
                participantId: member.participantId,
                result:
                  result.type === "interrupt_requested"
                    ? ("interrupt_requested" as const)
                    : ("already_idle" as const),
              };
            }),
          { concurrency: 1 },
        );
        return { crewInstanceId: instance.id, members };
      });

    return CrewStopService.of({ stop });
  }),
);

import type {
  OrchestrationV2AgentPersonaAssignment,
  OrchestrationV2AppThread,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { prepareAgentPersonaLaunch } from "../agents/agentPersonaLaunch.ts";
import { agentHandoffArtifactPath } from "../agents/agentPersonaArtifacts.ts";
import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { translateAgentPersonaProviderPolicy } from "../agents/agentPersonaProviderPolicy.ts";
import {
  AgentCrewInstanceService,
  type AgentCrewInstance,
  type NewAgentCrewMember,
} from "./AgentCrewInstanceService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { SpawnCompositionService } from "./SpawnCompositionService.ts";
import { CREW_SEAT_CAP } from "./crewLimits.ts";
import type { ParticipantId, SquadronId } from "./contracts.ts";
import {
  crewSeatRequestKey,
  lifecycleCommandId,
  spawnCrewInstanceId,
  spawnFirstTurnText,
  spawnHomeCommandId,
  spawnMessageId,
  spawnPlacementCommandId,
  spawnThreadId,
  spawnTitle,
} from "./spawnIds.ts";

/** One approved seat: who fills it, why, and any wiring text its brief carries verbatim. */
export interface CrewLaunchSeat {
  readonly name: string;
  readonly agentId: string;
  readonly reason: string | null;
  readonly instructions?: string | undefined;
}

/**
 * Hard cap per Crew, initial roster and additions together. The proposal gate checks it when a
 * roster or request is filed (counting pending requests); additions are also enforced inside the
 * store's reservation transaction so two approvals landing together cannot both slip under it.
 */
export { CREW_SEAT_CAP };

export interface CrewCaptain {
  readonly squadronId: SquadronId;
  readonly squadronName: string;
  readonly participantId: ParticipantId;
  readonly thread: OrchestrationV2AppThread;
}

export interface CrewLaunchInput {
  readonly providerSessionId: string;
  readonly requestKey: string;
  readonly captain: CrewCaptain;
  readonly displayName: string;
  readonly seats: ReadonlyArray<CrewLaunchSeat>;
  readonly brief: string;
  /**
   * Runs once the Crew is recorded and before any brief starts, so the caller can bind its own
   * record (the proposal) to the instance; a brief that fails afterwards then hands the gate back
   * to a proposal that already names its Crew, and the retry converges on the same seats.
   */
  readonly onRecorded?: (instance: AgentCrewInstance) => Effect.Effect<void>;
}

export interface CrewAddSeatsInput {
  readonly providerSessionId: string;
  readonly requestKey: string;
  readonly captain: CrewCaptain;
  readonly instance: AgentCrewInstance;
  readonly seats: ReadonlyArray<CrewLaunchSeat>;
  /** The brief the new seats start on; defaults to the Crew's original brief. */
  readonly brief?: string | undefined;
}

export class CrewLaunchSeatUnavailableError extends Data.TaggedError(
  "CrewLaunchSeatUnavailableError",
)<{ readonly seatName: string; readonly agentId: string; readonly detail: string }> {
  override get message(): string {
    return `Seat ${this.seatName} (agent ${this.agentId}) is unavailable: ${this.detail} Nothing was spawned.`;
  }
}

export class CrewLaunchPermissionError extends Data.TaggedError("CrewLaunchPermissionError")<{
  readonly seatName: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `Seat ${this.seatName} does not fit the Captain's permissions: ${this.detail} Nothing was spawned.`;
  }
}

export class CrewLaunchOperationError extends Data.TaggedError("CrewLaunchOperationError")<{
  readonly phase: string;
  readonly seatName: string | null;
  readonly createdSeats: ReadonlyArray<string>;
  readonly cause: unknown;
}> {
  override get message(): string {
    const cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    const seat = this.seatName === null ? "" : ` seat ${this.seatName}`;
    return `Crew launch failed while ${this.phase}${seat}: ${cause} Seats created so far: ${this.createdSeats.join(", ") || "none"}. Retry with the same request key; created seats replay and the rest continue.`;
  }
}

export type CrewLaunchError =
  | CrewLaunchSeatUnavailableError
  | CrewLaunchPermissionError
  | CrewLaunchOperationError;

export interface CrewLaunchServiceShape {
  /**
   * Launch an approved roster as persona-backed Peer Agents under the Captain, whole or not at
   * all: seats resolve first, spawn in order, the instance is recorded, then briefs start.
   */
  readonly launch: (input: CrewLaunchInput) => Effect.Effect<AgentCrewInstance, CrewLaunchError>;
  /** Spawn approved additional seats under the Captain of an existing Crew and bump its version. */
  readonly addSeats: (
    input: CrewAddSeatsInput,
  ) => Effect.Effect<AgentCrewInstance, CrewLaunchError>;
}

export class CrewLaunchService extends Context.Service<CrewLaunchService, CrewLaunchServiceShape>()(
  "t3/j5/a2a/CrewLaunchService",
) {}

export const layer = Layer.effect(
  CrewLaunchService,
  Effect.gen(function* () {
    const threadManagement = yield* ThreadManagementService;
    const composition = yield* SpawnCompositionService;
    const crews = yield* AgentCrewInstanceService;
    const registry = yield* ProviderRegistry;
    const agents = yield* makeAgentPersonaLibrary;

    interface ResolvedSeat {
      readonly seat: CrewLaunchSeat;
      readonly assignment: OrchestrationV2AgentPersonaAssignment;
      readonly runtimeMode: RuntimeMode;
      readonly outputArtifact: string | null;
    }

    // Resolve every seat before creating anything: a Crew launches whole or not at all.
    const resolveSeats = Effect.fn("j5.a2a.crewLaunch.resolveSeats")(function* (
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewLaunchSeat>,
    ) {
      const providers = yield* registry.getProviders;
      const resolved: Array<ResolvedSeat> = [];
      for (const seat of seats) {
        const assignment = yield* prepareAgentPersonaLaunch(
          { personaId: seat.agentId },
          providers,
          agents,
        ).pipe(
          Effect.mapError(
            (error) =>
              new CrewLaunchSeatUnavailableError({
                seatName: seat.name,
                agentId: seat.agentId,
                detail: error.message,
              }),
          ),
        );
        // Every seat reaching this point was approved by a human, and that approval is the
        // authority: the seat runs with its own agent's policy rather than inheriting the
        // Captain's read-only ceiling the way an agent-initiated spawn_agent child would.
        const policy = translateAgentPersonaProviderPolicy(
          assignment.authorityPolicy,
          assignment.resolvedDriver,
        );
        // The obligation is read from the same immutable snapshot the seat will run on, so a
        // later library edit cannot change what a running seat owes.
        const definition = yield* agents.readSnapshot(assignment).pipe(
          Effect.mapError(
            (error) =>
              new CrewLaunchSeatUnavailableError({
                seatName: seat.name,
                agentId: seat.agentId,
                detail: error.message,
              }),
          ),
        );
        resolved.push({
          seat,
          assignment,
          runtimeMode: policy.runtimeMode,
          outputArtifact: definition.outputArtifact ?? null,
        });
      }
      return resolved;
    });

    const plan = (
      providerSessionId: string,
      requestKey: string,
      seats: ReadonlyArray<ResolvedSeat>,
    ) =>
      seats.map((entry) => {
        const stableInput = {
          providerSessionId,
          requestKey: crewSeatRequestKey(requestKey, entry.seat.name),
        };
        const threadId = spawnThreadId(stableInput);
        return {
          ...entry,
          stableInput,
          threadId,
          participantId: participantIdForThread(threadId),
          agentDisplayName: entry.assignment.displayName ?? entry.seat.agentId,
        };
      });
    type Planned = ReturnType<typeof plan>[number];

    /** Create threads and commit home/placement facts; briefs are started separately. */
    const spawnSeats = Effect.fn("j5.a2a.crewLaunch.spawnSeats")(function* (
      captain: CrewCaptain,
      displayName: string,
      planned: ReadonlyArray<Planned>,
    ) {
      const members: Array<NewAgentCrewMember> = [];
      const operationError = (phase: string, seatName: string | null) => (cause: unknown) =>
        new CrewLaunchOperationError({
          phase,
          seatName,
          createdSeats: members.map(({ seatName: name }) => name),
          cause,
        });
      for (const member of planned) {
        yield* threadManagement
          .dispatch({
            type: "thread.create",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: lifecycleCommandId({ ...member.stableInput, operation: "spawn-create" }),
            threadId: member.threadId,
            projectId: captain.thread.projectId,
            title: spawnTitle(`${displayName} · ${member.seat.name}`, undefined),
            modelSelection: member.assignment.resolvedModelSelection,
            runtimeMode: member.runtimeMode,
            interactionMode: captain.thread.interactionMode,
            agentPersonaAssignment: member.assignment,
            branch: captain.thread.branch,
            worktreePath: captain.thread.worktreePath,
          })
          .pipe(Effect.mapError(operationError("creating the seat thread", member.seat.name)));
        const child = yield* threadManagement
          .getThreadProjection(member.threadId)
          .pipe(
            Effect.mapError(operationError("reading the created seat thread", member.seat.name)),
          );
        const facts = yield* composition
          .recordFacts({
            homeCommandId: spawnHomeCommandId(member.stableInput),
            placementCommandId: spawnPlacementCommandId(member.stableInput),
            squadronId: captain.squadronId,
            threadId: member.threadId,
            spawnedByParticipantId: captain.participantId,
            createdAt: DateTime.formatIso(child.thread.createdAt),
          })
          .pipe(
            Effect.mapError(operationError("recording home and placement for", member.seat.name)),
          );
        members.push({
          seatName: member.seat.name,
          agentId: member.seat.agentId,
          participantId: facts.home.participantId,
          threadId: member.threadId,
          reason: member.seat.reason,
        });
      }
      return members;
    });

    const startBriefs = Effect.fn("j5.a2a.crewLaunch.startBriefs")(function* (
      captain: CrewCaptain,
      instance: AgentCrewInstance,
      planned: ReadonlyArray<Planned>,
      brief: string,
    ) {
      const roster = instance.members.map((member) => ({
        seat: member.seatName,
        participantId: member.participantId,
        agentDisplayName:
          planned.find((entry) => entry.seat.name === member.seatName)?.agentDisplayName ??
          member.agentId,
      }));
      for (const member of planned) {
        yield* threadManagement
          .dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: lifecycleCommandId({ ...member.stableInput, operation: "spawn-brief" }),
            threadId: member.threadId,
            messageId: spawnMessageId(member.stableInput),
            text: spawnFirstTurnText({
              brief,
              participantId: member.participantId,
              squadronId: captain.squadronId,
              squadronName: captain.squadronName,
              crew: {
                displayName: instance.displayName,
                instanceId: instance.id,
                seatName: member.seat.name,
                seatInstructions: member.seat.instructions,
                captainParticipantId: captain.participantId,
                obligation:
                  member.outputArtifact === null
                    ? undefined
                    : {
                        kind: member.outputArtifact,
                        path: agentHandoffArtifactPath({
                          personaId: member.assignment.personaId,
                          artifact: member.outputArtifact,
                          threadId: member.threadId,
                        }),
                      },
                roster,
              },
            }),
            attachments: [],
            modelSelection: member.assignment.resolvedModelSelection,
            dispatchMode: { type: "start_immediately" },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CrewLaunchOperationError({
                  phase: "starting the brief for",
                  seatName: member.seat.name,
                  createdSeats: planned.map((entry) => entry.seat.name),
                  cause,
                }),
            ),
          );
      }
    });

    const launch: CrewLaunchServiceShape["launch"] = (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveSeats(input.captain, input.seats);
        const planned = plan(input.providerSessionId, input.requestKey, resolved);
        const members = yield* spawnSeats(input.captain, input.displayName, planned);
        // Record the unit before any member starts, so a member's own crew request is refused.
        const instance = yield* crews
          .record({
            id: spawnCrewInstanceId({
              providerSessionId: input.providerSessionId,
              requestKey: input.requestKey,
            }),
            squadronId: input.captain.squadronId,
            captainParticipantId: input.captain.participantId,
            captainThreadId: input.captain.thread.id,
            displayName: input.displayName,
            brief: input.brief,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            members,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CrewLaunchOperationError({
                  phase: "recording the crew",
                  seatName: null,
                  createdSeats: members.map(({ seatName }) => seatName),
                  cause,
                }),
            ),
          );
        if (input.onRecorded !== undefined) yield* input.onRecorded(instance);
        yield* startBriefs(input.captain, instance, planned, input.brief);
        return instance;
      });

    const addSeats: CrewLaunchServiceShape["addSeats"] = (input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveSeats(input.captain, input.seats);
        const planned = plan(input.providerSessionId, input.requestKey, resolved);
        // Reserve the seats before anything spawns: the store decides the cap and the version in
        // one transaction, so two approvals landing together cannot both pass. Seat ids are
        // deterministic, so a retry after a failed spawn finds its reservation and converges.
        const reservation = yield* crews
          .addMembers(
            input.instance.id,
            planned.map((member) => ({
              seatName: member.seat.name,
              agentId: member.seat.agentId,
              participantId: member.participantId,
              threadId: member.threadId,
              reason: member.seat.reason,
            })),
            { maxSeats: CREW_SEAT_CAP },
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new CrewLaunchOperationError({
                  phase: "reserving the added seats",
                  seatName: null,
                  createdSeats: [],
                  cause,
                }),
            ),
          );
        if (reservation.status === "missing" || reservation.instance === null)
          return yield* new CrewLaunchOperationError({
            phase: "reserving the added seats",
            seatName: null,
            createdSeats: [],
            cause: `crew ${input.instance.id} no longer exists`,
          });
        if (reservation.status === "cap-exceeded")
          return yield* new CrewLaunchPermissionError({
            seatName: planned[0]?.seat.name ?? "",
            detail: `Crew ${input.instance.id} holds ${reservation.instance.members.length} seats; adding ${planned.length} would exceed the cap of ${CREW_SEAT_CAP}.`,
          });
        yield* spawnSeats(input.captain, input.instance.displayName, planned);
        yield* startBriefs(
          input.captain,
          reservation.instance,
          planned,
          input.brief ?? reservation.instance.brief,
        );
        return reservation.instance;
      });

    return CrewLaunchService.of({ launch, addSeats });
  }),
);

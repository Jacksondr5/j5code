import { agentPersonaPolicy } from "../agents/agentPersonas.ts";
import { CrewSeatWorkspace } from "@t3tools/contracts/j5";
import {
  agentPersonaEntryMatches,
  agentPersonaTargetUnavailableReason,
} from "../agents/agentPersonaRouting.ts";
import { crewModelSelectionProblem } from "../agents/agentModelSelection.ts";
import { describeCrewSeatRuntime, materializeCrewModelSelection } from "./crewRuntimePreview.ts";
import type { CrewProposalSeatRuntime, CrewWorkspaceOptions } from "@t3tools/contracts/j5";
import { type AgentPersonaBlockCode, isProviderAvailable } from "@t3tools/contracts";
import type {
  ModelSelection,
  OrchestrationV2AgentPersonaCommandAssignment,
  OrchestrationV2AppThread,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { AgentPersonaEscalations } from "../agents/agentPersonaEscalation.ts";
import { findAgentPersonaDefinition } from "../agents/agentPersonaLaunch.ts";
import { CrewMemberModels } from "../agents/crewMemberModels.ts";
import {
  agentAccessOf,
  AgentPersonaPickError,
  assertWithinCallerAccess,
  pickAgentPersona,
  resolveCallerAccess,
} from "../agents/agentPersonaPick.ts";
import {
  resolveReviewAuthors,
  reviewIndependenceOf,
  withReviewIndependenceNote,
  type ReviewAuthorsRequest,
} from "../agents/agentPersonaReviewIndependence.ts";
import {
  AgentPersonaLibraryError,
  makeAgentPersonaLibrary,
} from "../agents/agentPersonaLibrary.ts";
import {
  providerCanEnforceAgentPersonaAuthority,
  translateAgentPersonaProviderPolicy,
} from "../agents/agentPersonaProviderPolicy.ts";
import {
  AgentCrewInstanceService,
  CrewStepAlreadyOwnedError,
  replacementProblem,
  stepOwnershipConflict,
  type AgentCrewInstance,
} from "./AgentCrewInstanceService.ts";
import { j5AnalyticsRecorder } from "../analytics/recorder.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { SpawnCompositionService } from "./SpawnCompositionService.ts";
import {
  type ResolvedSpawnWorkspace,
  type SpawnWorkspaceChoice,
  SpawnWorkspaceService,
  namedBaseRefs,
  namedWorktreePaths,
  resolveSpawnWorkspace,
  SpawnWorkspaceError,
  spawnCreateCommandId,
  spawnThreadCheckout,
} from "./spawnWorkspace.ts";
import { getThreadRecordsIfPresent } from "./threadProjectionReads.ts";
import { CREW_SEAT_CAP } from "./crewLimits.ts";
import type { ParticipantId, LedgerProjectId } from "./contracts.ts";
import {
  crewSeatRequestKey,
  spawnCrewInstanceId,
  lifecycleCommandId,
  spawnFirstTurnText,
  spawnHomeCommandId,
  spawnPlacementCommandId,
  spawnThreadId,
  spawnTitle,
} from "./spawnIds.ts";

/**
 * One approved seat: who fills it, why, and any wiring text its brief carries verbatim. A null
 * agent is a custom seat: the human can override its runtime; an omitted model selection inherits
 * the Captain's. Omitted access is Full access on a roster the person approves, and the Captain's
 * own access on an auto-approved one.
 */
export interface CrewLaunchSeat {
  readonly name: string;
  readonly agentId: string | null;
  readonly reason: string | null;
  readonly instructions?: string | undefined;
  /** Replaces the persona's own instructions for this seat; set only by the person's roster card. */
  readonly personaInstructions?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  /** Ids of the playbook steps the seat owns; recorded on its member row. */
  readonly steps?: ReadonlyArray<string> | undefined;
  /** For an independent reviewer: the seats or members it reviews; default every non-reviewer. */
  readonly reviews?: ReadonlyArray<string> | undefined;
  /** Where the seat works, chosen for every seat. */
  readonly workspace: SpawnWorkspaceChoice;
  /** A granted escalation the Captain retries this persona seat with; only an agent's pick reads it. */
  readonly allowOnce?: string | undefined;
}

/**
 * The playbook a Crew follows as its seats are briefed: its identity for the record, and the live
 * step titles each seat's first turn lists.
 */
export interface CrewLaunchPlaybook {
  readonly name: string;
  readonly definitionPath: string;
  readonly title: string;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

/**
 * Hard cap per Crew, initial roster and additions together. The proposal gate checks it when a
 * roster or request is filed (counting pending requests); additions are also enforced inside the
 * store's reservation transaction so two approvals landing together cannot both slip under it.
 */
export { CREW_SEAT_CAP };

export interface CrewCaptain {
  readonly projectId: LedgerProjectId;
  readonly projectTitle: string;
  readonly participantId: ParticipantId;
  readonly thread: OrchestrationV2AppThread;
}

/** One immutable resolution shared by preview, approval validation, and thread creation. */
export interface ResolvedCrewLaunchSeat {
  readonly seat: CrewLaunchSeat;
  readonly assignment: OrchestrationV2AgentPersonaCommandAssignment | null;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly agentDisplayName: string;
  readonly workspace: ResolvedSpawnWorkspace;
  readonly runtime: CrewProposalSeatRuntime;
}

export interface CrewLaunchInput {
  readonly providerSessionId: string;
  readonly requestKey: string;
  readonly captain: CrewCaptain;
  readonly displayName: string;
  readonly seats: ReadonlyArray<CrewLaunchSeat>;
  readonly resolvedSeats?: ReadonlyArray<ResolvedCrewLaunchSeat>;
  /** Who chose the seats: the person, on a card they approved, or an agent. */
  readonly pick: CrewSeatPick;
  readonly brief: string;
  readonly playbook?: CrewLaunchPlaybook | null | undefined;
  /**
   * Runs once the Crew is recorded and before any seat spawns, so the caller can bind its own
   * record (the proposal) to the instance and resolve it. A failure here aborts the launch with
   * no seat spawned; recording is idempotent, so the same approval can be made again.
   */
  readonly onRecorded?: (
    instance: AgentCrewInstance,
  ) => Effect.Effect<void, CrewLaunchOperationError>;
}

export interface CrewAddSeatsInput {
  readonly providerSessionId: string;
  readonly requestKey: string;
  readonly captain: CrewCaptain;
  readonly instance: AgentCrewInstance;
  readonly seats: ReadonlyArray<CrewLaunchSeat>;
  readonly resolvedSeats?: ReadonlyArray<ResolvedCrewLaunchSeat>;
  /** Who chose the seats: the person, on a card they approved, or an agent. */
  readonly pick: CrewSeatPick;
  /** The brief the new seats start on; defaults to the Crew's original brief. */
  readonly brief?: string | undefined;
  /** The Crew's playbook with live titles, for the new seats' briefs. */
  readonly playbook?: CrewLaunchPlaybook | null | undefined;
  /**
   * Runs once the seats are reserved and before any spawns, like `onRecorded` on a launch. A
   * failure releases the reservation, so the request can be approved again.
   */
  readonly onReserved?: (
    instance: AgentCrewInstance,
  ) => Effect.Effect<void, CrewLaunchOperationError>;
  /**
   * Set when the one added seat replaces a live seat. Nothing is reserved: the seat launches, and
   * only a seat that was created is swapped in, so a failed launch moves nothing.
   */
  readonly replacement?: CrewSeatReplacement | undefined;
}

export interface CrewSeatReplacement {
  readonly seatName: string;
  /**
   * The replaced seat's steps that move: the run's current step and every later one it owns.
   * Read under the Crew's lock, where no step call can move the run; a failure refuses the seat.
   */
  readonly unfinishedSteps: (
    crew: AgentCrewInstance,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    CrewLaunchSeatUnavailableError | CrewLaunchOperationError
  >;
}

/** The line a replacement's first turn carries about the seat it takes over. */
const crewReplacementLine = (input: {
  readonly seatName: string;
  readonly model: string | null;
  readonly threadId: string;
}) =>
  `You replace seat ${input.seatName}${input.model === null ? "" : `, which ran on ${input.model}`}. Its thread is ${input.threadId}; read it with t3_thread_read before continuing.`;

/**
 * How one approved seat's launch went: `created` when its thread and home exist and it is waiting for work;
 * `not_created` when its thread was never created, so its row is dropped and nothing can message
 * it; `not_started` when the thread exists but its home or placement did not go through.
 */
export type CrewSeatLaunchOutcome =
  | { readonly seatName: string; readonly kind: "created" }
  | { readonly seatName: string; readonly kind: "not_created"; readonly detail: string }
  | { readonly seatName: string; readonly kind: "not_started"; readonly detail: string };

export interface CrewLaunchResult {
  /** The Crew as launched: seats that were never created are no longer on it. */
  readonly instance: AgentCrewInstance;
  readonly seats: ReadonlyArray<CrewSeatLaunchOutcome>;
}

export class CrewLaunchSeatUnavailableError extends Data.TaggedError(
  "CrewLaunchSeatUnavailableError",
)<{
  readonly seatName: string;
  readonly agentId: string;
  readonly detail: string;
  /** Why a persona seat was refused, the same code its other launch paths give. */
  readonly blockCode?: AgentPersonaBlockCode | undefined;
}> {
  override get message(): string {
    return `Seat ${this.seatName} (agent ${this.agentId}) is unavailable: ${this.detail} Nothing was spawned.`;
  }
}

/** A custom seat's model or reasoning level is not on the project's "Models for custom members" lists. */
class CrewLaunchModelNotEligibleError extends Data.TaggedError("CrewLaunchModelNotEligibleError")<{
  readonly seatName: string;
  readonly detail: string;
  /** For a persona seat, the code its other launch paths give the same block. */
  readonly blockCode?: AgentPersonaBlockCode | undefined;
}> {
  override get message(): string {
    return `Seat ${this.seatName}: ${this.detail} Nothing was spawned.`;
  }
}

/** The Crew is full; the seats it holds already reach the cap once the request is counted. */
class CrewLaunchCapError extends Data.TaggedError("CrewLaunchCapError")<{
  readonly crewInstanceId: string;
  readonly held: number;
  readonly adding: number;
  readonly cap: number;
}> {
  override get message(): string {
    return `Crew ${this.crewInstanceId} holds ${this.held} seats; adding ${this.adding} would exceed the cap of ${this.cap}. Nothing was spawned.`;
  }
}

/** A seat name the reservation could not take: another participant already holds it. */
class CrewLaunchSeatConflictError extends Data.TaggedError("CrewLaunchSeatConflictError")<{
  readonly crewInstanceId: string;
  readonly seatNames: ReadonlyArray<string>;
}> {
  override get message(): string {
    return `Crew ${this.crewInstanceId} already holds ${this.seatNames.length === 1 ? "a seat" : "seats"} named ${this.seatNames.join(", ")} filled by a different agent. Nothing was spawned.`;
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
    return `Crew launch failed while ${this.phase}${seat}: ${cause} Seats created so far: ${this.createdSeats.join(", ") || "none"}.`;
  }
}

export type CrewLaunchError =
  | CrewLaunchSeatUnavailableError
  | CrewLaunchModelNotEligibleError
  | CrewLaunchCapError
  | CrewLaunchSeatConflictError
  | CrewLaunchOperationError
  // Passed through every wrapper so the gate can refuse the approval with its own words.
  | CrewStepAlreadyOwnedError;

/** Wraps a store failure for the launch, except a step-ownership refusal, which stays typed. */
const unlessStepOwned =
  (wrap: (cause: unknown) => CrewLaunchOperationError) =>
  <E>(cause: E): CrewLaunchOperationError | CrewStepAlreadyOwnedError =>
    cause instanceof CrewStepAlreadyOwnedError ? cause : wrap(cause);

/**
 * Who chose the roster: the person, on a card they approved (edited or not), or an agent, on an
 * auto-approved roster or addition. An agent's seats are held to the Captain's access.
 */
export type CrewSeatPick = "person" | "agent";

export interface CrewLaunchServiceShape {
  readonly resolveSeats: (
    captain: CrewCaptain,
    seats: ReadonlyArray<CrewLaunchSeat>,
    pick: CrewSeatPick,
    /** The Crew the seats join, for an addition: its members, live or replaced, are authors a reviewer may review. */
    crew?: Pick<AgentCrewInstance, "members" | "replaced"> | null,
  ) => Effect.Effect<ReadonlyArray<ResolvedCrewLaunchSeat>, CrewLaunchError>;
  /**
   * Each seat's workspace choice as it should be stored: a new worktree's base resolved to a
   * commit and saved on the choice, anything else as given. Refuses a base that resolves to
   * nothing, naming the seat. Only worktree seats are read from the repository.
   */
  readonly pinWorkspaces: (
    captain: CrewCaptain,
    seats: ReadonlyArray<CrewLaunchSeat>,
  ) => Effect.Effect<ReadonlyArray<SpawnWorkspaceChoice>, SpawnWorkspaceError>;
  /**
   * Launch an approved roster once: seats resolve, the instance is recorded with every planned
   * seat, `onRecorded` runs, then every seat is attempted and briefed. A seat that fails does not
   * stop the next one; each seat's outcome is returned, and a seat whose thread was never created
   * is dropped from the record so the roster matches what exists.
   */
  readonly launch: (input: CrewLaunchInput) => Effect.Effect<CrewLaunchResult, CrewLaunchError>;
  /** Spawn approved additional seats under the Captain of an existing Crew, the same way. */
  readonly addSeats: (input: CrewAddSeatsInput) => Effect.Effect<CrewLaunchResult, CrewLaunchError>;
  /**
   * What the roster card can offer a seat's workspace: the Captain's branch, the directory
   * its base-branch picker searches, and the project's worktrees. An unreadable repository offers none.
   */
  readonly workspaceOptions: (captain: CrewCaptain) => Effect.Effect<CrewWorkspaceOptions>;
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
    const recordAnalytics = yield* j5AnalyticsRecorder;
    const registry = yield* ProviderRegistry;
    const agents = yield* makeAgentPersonaLibrary;
    const spawnWorkspace = yield* SpawnWorkspaceService;
    const memberModels = yield* CrewMemberModels;
    const escalations = yield* AgentPersonaEscalations;

    /** One read of the Captain's repository for what these seats name; null when all are shared. */
    const inspectWorkspaces = (captain: CrewCaptain, seats: ReadonlyArray<CrewLaunchSeat>) =>
      seats.every((seat) => seat.workspace.type === "shared")
        ? Effect.succeed(null)
        : spawnWorkspace.inspect({
            projectId: captain.thread.projectId,
            worktreePath: captain.thread.worktreePath,
            checkBranches: seats.some(
              (seat) => seat.workspace.type === "worktree" && seat.workspace.branch !== undefined,
            ),
            baseRefs: namedBaseRefs(seats.map((seat) => seat.workspace)),
            pinBases: true,
            existingWorktreePaths: namedWorktreePaths(seats.map((seat) => seat.workspace)),
          });

    const pinWorkspaces = Effect.fn("j5.a2a.crewLaunch.pinWorkspaces")(function* (
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewLaunchSeat>,
    ) {
      const checkout = yield* inspectWorkspaces(
        captain,
        seats.filter((seat) => seat.workspace.type === "worktree"),
      );
      if (checkout === null) return seats.map((seat) => seat.workspace);
      return yield* Effect.forEach(
        seats,
        (seat): Effect.Effect<SpawnWorkspaceChoice, SpawnWorkspaceError> => {
          const { workspace } = seat;
          if (workspace.type !== "worktree") return Effect.succeed(workspace);
          return Effect.fromResult(resolveSpawnWorkspace(checkout, workspace)).pipe(
            Effect.map((resolved) =>
              resolved.type === "worktree" && resolved.baseCommit !== undefined
                ? { ...workspace, baseCommit: resolved.baseCommit }
                : workspace,
            ),
            Effect.mapError(
              (error) =>
                new SpawnWorkspaceError({
                  detail: `Seat "${seat.name}": ${error.detail}`,
                  nextStep: error.nextStep,
                }),
            ),
          );
        },
      );
    });

    // Resolve every seat before creating anything: a Crew launches whole or not at all.
    const resolveSeatsWithPick = Effect.fn("j5.a2a.crewLaunch.resolveSeats")(function* (
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewLaunchSeat>,
      pick: CrewSeatPick,
      crew: Pick<AgentCrewInstance, "members" | "replaced"> | null,
    ) {
      const agentPick = pick === "agent";
      // Read once: an agent's seats are held to the Captain's access and the project's lists.
      const limit = agentPick
        ? yield* resolveCallerAccess({ thread: captain.thread }).pipe(
            Effect.mapError(
              (cause) =>
                new CrewLaunchOperationError({
                  phase: "reading the Captain's access",
                  seatName: null,
                  createdSeats: [],
                  cause,
                }),
            ),
          )
        : undefined;
      const caller = limit === undefined ? { thread: captain.thread } : { access: limit };
      const eligible = agentPick
        ? yield* memberModels.eligibility(captain.thread.projectId)
        : undefined;
      const providers = yield* registry.getProviders;
      const now = yield* Clock.currentTimeMillis;
      // Every seat's workspace resolves against one read of the Captain's repository, here at
      // preview, so the approval token binds what each seat will get. Shared seats need none.
      const checkout = yield* inspectWorkspaces(captain, seats);
      const resolveWorkspace = (seat: CrewLaunchSeat) =>
        Effect.fromResult(
          checkout === null
            ? Result.succeed({ type: "shared" } as const)
            : resolveSpawnWorkspace(checkout, seat.workspace),
        ).pipe(
          Effect.mapError(
            (error) =>
              new CrewLaunchSeatUnavailableError({
                seatName: seat.name,
                agentId: seat.agentId ?? "custom seat",
                detail: `${error.detail} ${error.nextStep}`,
              }),
          ),
        );
      const resolved = new Map<string, ResolvedCrewLaunchSeat>();
      const reviewerIds = seats.some(({ agentId }) => agentId !== null)
        ? new Set(
            (yield* agents.catalog().pipe(
              Effect.mapError(
                (cause) =>
                  new CrewLaunchOperationError({
                    phase: "reading the persona library",
                    seatName: null,
                    createdSeats: [],
                    cause,
                  }),
              ),
            )).definitions.flatMap(({ id, independentReviewer }) =>
              independentReviewer === true ? [id] : [],
            ),
          )
        : new Set<string>();
      const isReviewer = (seat: CrewLaunchSeat) =>
        seat.agentId !== null && reviewerIds.has(seat.agentId);
      // A reviewer's authors are the seats and members it reviews; by default every one that is
      // not a reviewer itself. A replaced member's work is still in the Crew's, so it counts too.
      // Seats on this roster resolve first, so their models are known.
      const reviewAuthors = (seat: CrewLaunchSeat): ReviewAuthorsRequest => {
        // A name the person renamed or removed on the card is dropped; with none left, the default.
        const named = seat.reviews?.filter(
          (name) =>
            seats.some((other) => other.name === name) ||
            (crew?.members ?? []).some((member) => member.seatName === name),
        );
        const reviews = named === undefined || named.length === 0 ? undefined : named;
        const reviewed = (name: string) =>
          name !== seat.name && (reviews === undefined || reviews.includes(name));
        const rosterSeats = seats.filter(
          (other) => reviewed(other.name) && (reviews !== undefined || !isReviewer(other)),
        );
        return {
          threads: [...(crew?.members ?? []), ...(crew?.replaced ?? [])]
            .filter((member) => reviewed(member.seatName))
            .map((member) => ({
              threadId: member.threadId,
              skipReviewer: reviews === undefined,
            })),
          models: rosterSeats.flatMap(
            (other) => resolved.get(other.name)?.modelSelection.model ?? [],
          ),
          partlyUnknown: rosterSeats.some((other) => !resolved.has(other.name)),
        };
      };
      // `custom` seats run on whatever the project's lists of models and reasoning levels for
      // custom members allow. A persona seat that keeps its persona's own model and level is not
      // custom and skips the lists.
      const resolveSelection = Effect.fn("j5.a2a.crewLaunch.resolveSelection")(function* (
        seat: CrewLaunchSeat,
        selection: ModelSelection,
        custom: boolean,
      ) {
        const provider = providers.find(
          (candidate) => candidate.instanceId === selection.instanceId,
        );
        const problem =
          provider === undefined
            ? "is no longer configured"
            : !isProviderAvailable(provider)
              ? "is unavailable"
              : !provider.enabled || provider.status === "disabled"
                ? "is disabled"
                : !provider.installed
                  ? "is not installed"
                  : provider.status === "error"
                    ? "reports an error"
                    : provider.auth.status === "unauthenticated"
                      ? "is signed out"
                      : !provider.models.some((model) => model.slug === selection.model)
                        ? `does not advertise ${selection.model}`
                        : null;
        if (problem !== null)
          return yield* new CrewLaunchSeatUnavailableError({
            seatName: seat.name,
            agentId: seat.agentId ?? "custom seat",
            detail: `Provider ${selection.instanceId} ${problem}.`,
          });
        const modelSelection = materializeCrewModelSelection(selection, provider!);
        const optionProblem =
          seat.modelSelection === undefined
            ? null
            : crewModelSelectionProblem(modelSelection, provider!);
        if (optionProblem !== null)
          return yield* new CrewLaunchSeatUnavailableError({
            seatName: seat.name,
            agentId: seat.agentId ?? "custom seat",
            detail: optionProblem,
          });
        if (custom)
          yield* memberModels
            .assertEligible({ projectId: captain.thread.projectId, selection })
            .pipe(
              Effect.mapError(
                (error) =>
                  new CrewLaunchModelNotEligibleError({
                    seatName: seat.name,
                    detail: error.message,
                  }),
              ),
            );
        return { modelSelection, provider: provider! };
      });
      for (const seat of [
        ...seats.filter((seat) => !isReviewer(seat)),
        ...seats.filter(isReviewer),
      ]) {
        const agentId = seat.agentId;
        const pickRefused = (error: AgentPersonaPickError) =>
          new CrewLaunchSeatUnavailableError({
            seatName: seat.name,
            agentId: agentId ?? "custom seat",
            detail: error.message,
            blockCode: error.code,
          });
        if (agentId === null) {
          const selection = seat.modelSelection ?? captain.thread.modelSelection;
          const { modelSelection, provider } = yield* resolveSelection(seat, selection, true);
          // On a card the person approves, a seat nobody configured runs in Full access, so it
          // never stops for approvals in a thread the person is not watching; they see and can
          // change it there. Without the card, a seat gets no more than its Captain runs with.
          const runtimeMode = seat.runtimeMode ?? limit?.runtimeMode ?? "full-access";
          if (agentPick)
            yield* assertWithinCallerAccess(
              `Custom seat ${seat.name}`,
              { runtimeMode },
              caller,
            ).pipe(Effect.mapError(pickRefused));
          if (
            provider!.driver === "acpRegistry" &&
            (runtimeMode === "auto" || runtimeMode === "auto-accept-edits")
          )
            return yield* new CrewLaunchSeatUnavailableError({
              seatName: seat.name,
              agentId: "custom seat",
              // Without the card, Full access is allowed only when the Captain runs with it.
              detail:
                limit === undefined || limit.runtimeMode === "full-access"
                  ? "This ACP harness cannot enforce the selected access mode. Choose Supervised or Full access."
                  : "This ACP harness cannot enforce the selected access mode, and Full access is broader than the Captain's. Set runtime_mode to approval-required (Supervised).",
            });
          // Custom seats carry the selected access mode, without a persona sandbox assignment.
          const workspace = yield* resolveWorkspace(seat);
          resolved.set(seat.name, {
            seat,
            assignment: null,
            modelSelection,
            workspace,
            runtime: {
              ...describeCrewSeatRuntime(seat.name, modelSelection, provider!, runtimeMode, null),
              workspace,
            },
            runtimeMode,
            agentDisplayName: "custom",
          });
          continue;
        }
        const prepared = yield* Effect.gen(function* () {
          if (seat.modelSelection === undefined) {
            const { assignment: prepared } = yield* pickAgentPersona({
              personaId: agentId,
              source: pick,
              caller,
              projectId: captain.thread.projectId,
              runtimeMode: seat.runtimeMode,
              eligible,
              ...(isReviewer(seat) ? { reviewAuthors: reviewAuthors(seat) } : {}),
              // A card the person previews shows the refusal to them, so only the Captain's
              // own pick escalates.
              escalateFor: agentPick ? captain.participantId : undefined,
              allowOnce: seat.allowOnce,
            });
            return {
              ...prepared,
              resolvedModelSelection: (yield* resolveSelection(
                seat,
                prepared.resolvedModelSelection,
                false,
              )).modelSelection,
              ...(seat.runtimeMode === undefined ? {} : { runtimeModeOverride: seat.runtimeMode }),
            };
          }
          const definition = yield* findAgentPersonaDefinition(agentId, agents).pipe(
            Effect.mapError(
              (error) =>
                new CrewLaunchSeatUnavailableError({
                  seatName: seat.name,
                  agentId,
                  detail: error.message,
                  blockCode: error.code,
                }),
            ),
          );
          // Editing any field on the roster card freezes the model it showed into the seat, and
          // that is the fallback route when the primary's provider was signed out at proposal
          // time. A seat counts as keeping the persona's model and level by matching either route,
          // never by its absence.
          const frozen = seat.modelSelection;
          const frozenProvider = providers.find(
            (candidate) => candidate.instanceId === frozen.instanceId,
          );
          const matchingIndex =
            definition?.modelRoute.findIndex(
              (target) =>
                frozenProvider !== undefined &&
                agentPersonaEntryMatches(
                  target,
                  materializeCrewModelSelection(frozen, frozenProvider),
                  frozenProvider.driver,
                ),
            ) ?? -1;
          const keepsPersonaModel = matchingIndex >= 0;
          // An agent's pick is held to the lists whichever entry it froze.
          const { modelSelection, provider } = yield* resolveSelection(
            seat,
            seat.modelSelection,
            !keepsPersonaModel || agentPick,
          );
          if (
            seat.runtimeMode === undefined &&
            !providerCanEnforceAgentPersonaAuthority(
              provider.driver,
              agentPersonaPolicy(definition),
            )
          )
            return yield* new CrewLaunchSeatUnavailableError({
              seatName: seat.name,
              agentId,
              detail:
                "This harness cannot enforce the persona's default access. Select an explicit access mode.",
              blockCode: "models_exhausted",
            });
          const declared = definition.modelRoute[matchingIndex];
          if (declared !== undefined) {
            const unavailable = agentPersonaTargetUnavailableReason(provider, declared, now);
            if (unavailable !== undefined)
              return yield* new CrewLaunchSeatUnavailableError({
                seatName: seat.name,
                agentId,
                detail: `Persona entry ${matchingIndex + 1} is unavailable: ${unavailable}.`,
                blockCode: "models_exhausted",
              });
          }
          if (agentPick)
            yield* assertWithinCallerAccess(
              `Persona ${agentId}`,
              seat.runtimeMode === undefined
                ? agentAccessOf(
                    translateAgentPersonaProviderPolicy(
                      agentPersonaPolicy(definition),
                      provider.driver,
                    ),
                  )
                : { runtimeMode: seat.runtimeMode },
              caller,
            );
          const definitionDigest = yield* agents.snapshot(definition);
          // The person chose this model on the card, so it is noted, never reordered.
          const reviewIndependence = isReviewer(seat)
            ? reviewIndependenceOf(
                yield* resolveReviewAuthors(reviewAuthors(seat)),
                modelSelection.model,
                "person",
              )
            : undefined;
          return {
            personaId: agentId,
            definitionVersion: definition.version,
            definitionDigest,
            displayName: definition.displayName,
            authorityPolicy: agentPersonaPolicy(definition),
            resolvedRoute: keepsPersonaModel
              ? matchingIndex === 0
                ? ("primary" as const)
                : ("fallback" as const)
              : ("override" as const),
            ...(keepsPersonaModel ? { resolvedEntryIndex: matchingIndex } : {}),
            resolvedDriver: provider.driver,
            resolvedModelSelection: modelSelection,
            ...(seat.runtimeMode === undefined ? {} : { runtimeModeOverride: seat.runtimeMode }),
            pickSource: { kind: pick },
            ...(reviewIndependence === undefined ? {} : { reviewIndependence }),
          };
        }).pipe(
          // The lists refuse a persona's own entries as they refuse a model chosen on the card.
          Effect.mapError((error) =>
            error._tag === "CrewLaunchModelNotEligibleError" ||
            error._tag === "CrewLaunchSeatUnavailableError"
              ? error
              : // A blocked persona keeps the code every launch path gives it.
                error._tag === "AgentPersonaPickError" && error.constraint === "model-not-eligible"
                ? new CrewLaunchModelNotEligibleError({
                    seatName: seat.name,
                    detail: error.message,
                    blockCode: error.code,
                  })
                : new CrewLaunchSeatUnavailableError({
                    seatName: seat.name,
                    agentId,
                    detail: error.message,
                    blockCode: "code" in error ? error.code : undefined,
                  }),
          ),
        );
        // The person's edited text runs instead of the persona's, never beside it: the seat's
        // assignment points at a snapshot of the persona with that text.
        const assignment =
          seat.personaInstructions === undefined
            ? prepared
            : yield* agents.readSnapshot(prepared).pipe(
                Effect.flatMap((definition) =>
                  agents.snapshot({ ...definition, instructions: seat.personaInstructions! }),
                ),
                Effect.flatMap((definitionDigest) =>
                  definitionDigest === undefined
                    ? Effect.fail(
                        new AgentPersonaLibraryError({
                          message: "Persona snapshot storage is unavailable.",
                        }),
                      )
                    : Effect.succeed({ ...prepared, definitionDigest, instructionsEdited: true }),
                ),
                Effect.mapError(
                  (error) =>
                    new CrewLaunchSeatUnavailableError({
                      seatName: seat.name,
                      agentId,
                      detail: error.message,
                    }),
                ),
              );
        // Explicit runtime choices override the persona sandbox for both human-approved and
        // automatic launches; behavior instructions stay pinned to the original snapshot.
        const policy = translateAgentPersonaProviderPolicy(
          assignment.authorityPolicy,
          assignment.resolvedDriver,
        );
        const runtimeMode = seat.runtimeMode ?? policy.runtimeMode;
        if (
          assignment.resolvedDriver === "acpRegistry" &&
          (runtimeMode === "auto" || runtimeMode === "auto-accept-edits")
        )
          return yield* new CrewLaunchSeatUnavailableError({
            seatName: seat.name,
            agentId,
            detail:
              "This ACP harness cannot enforce the selected access mode. Choose Supervised or Full access.",
          });
        // A snapshot that cannot be read fails the seat here, before it launches.
        yield* agents.readSnapshot(assignment).pipe(
          Effect.mapError(
            (error) =>
              new CrewLaunchSeatUnavailableError({
                seatName: seat.name,
                agentId,
                detail: error.message,
              }),
          ),
        );
        const workspace = yield* resolveWorkspace(seat);
        resolved.set(seat.name, {
          seat,
          assignment,
          modelSelection: assignment.resolvedModelSelection,
          workspace,
          runtime: {
            ...describeCrewSeatRuntime(
              seat.name,
              assignment.resolvedModelSelection,
              providers.find(
                (provider) => provider.instanceId === assignment.resolvedModelSelection.instanceId,
              )!,
              runtimeMode,
              assignment,
            ),
            workspace,
          },
          runtimeMode,
          agentDisplayName: assignment.displayName ?? agentId,
        });
      }
      return seats.map((seat) => resolved.get(seat.name)!);
    });
    // The pick check reads the same eligibility lists, providers and threads this launcher holds.
    const resolveSeats = (
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewLaunchSeat>,
      pick: CrewSeatPick,
      crew: Pick<AgentCrewInstance, "members" | "replaced"> | null = null,
    ) =>
      resolveSeatsWithPick(captain, seats, pick, crew).pipe(
        Effect.provideService(CrewMemberModels, memberModels),
        Effect.provideService(ProviderRegistry, registry),
        Effect.provideService(ThreadManagementService, threadManagement),
        Effect.provideService(AgentPersonaEscalations, escalations),
      );

    /** A seat let past its limit once spends that allowance as it launches. */
    const spendAllowances = (resolved: ReadonlyArray<ResolvedCrewLaunchSeat>) =>
      Effect.forEach(
        resolved.filter(
          ({ seat, assignment }) =>
            seat.allowOnce !== undefined && assignment?.pickSource?.kind === "allow-once",
        ),
        ({ seat }) =>
          escalations.use(seat.allowOnce!).pipe(
            Effect.mapError(
              (error) =>
                new CrewLaunchSeatUnavailableError({
                  seatName: seat.name,
                  agentId: seat.agentId ?? "custom seat",
                  detail: error.message,
                }),
            ),
          ),
        { discard: true },
      );

    const plan = (
      providerSessionId: string,
      requestKey: string,
      seats: ReadonlyArray<ResolvedCrewLaunchSeat>,
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
        };
      });
    type Planned = ReturnType<typeof plan>[number];

    const detailOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

    /** Create one seat's thread and commit its home and placement. */
    const startSeat = Effect.fn("j5.a2a.crewLaunch.startSeat")(function* (
      captain: CrewCaptain,
      member: Planned,
    ) {
      const seatName = member.seat.name;
      const create = yield* Effect.result(
        threadManagement.dispatch({
          type: "thread.create",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: spawnCreateCommandId(member.stableInput, member.workspace.type),
          threadId: member.threadId,
          projectId: captain.thread.projectId,
          // The seat's name alone: the sidebar group and the Crew chip already say which Crew.
          title: spawnTitle(seatName),
          modelSelection: member.modelSelection,
          runtimeMode: member.runtimeMode,
          interactionMode: captain.thread.interactionMode,
          ...(member.assignment === null ? {} : { agentPersonaAssignment: member.assignment }),
          ...spawnThreadCheckout(member.workspace, captain.thread),
        }),
      );
      const child = yield* Effect.result(
        getThreadRecordsIfPresent(threadManagement, member.threadId, []),
      );
      if (Result.isFailure(child))
        return {
          seatName,
          kind: "not_started",
          detail: `reading the seat thread failed: ${detailOf(child.failure)}`,
        } satisfies CrewSeatLaunchOutcome;
      if (child.success === null)
        return {
          seatName,
          kind: "not_created",
          detail: Result.isFailure(create)
            ? detailOf(create.failure)
            : "the thread did not appear after it was created",
        } satisfies CrewSeatLaunchOutcome;
      const facts = yield* Effect.result(
        composition.recordFacts({
          homeCommandId: spawnHomeCommandId(member.stableInput),
          placementCommandId: spawnPlacementCommandId(member.stableInput),
          projectId: captain.projectId,
          threadId: member.threadId,
          provenance: {
            kind: "spawned-by",
            spawnedByParticipantId: captain.participantId,
            source: "j5_spawn",
          },
          createdAt: DateTime.formatIso(child.success.thread.createdAt),
        }),
      );
      if (Result.isFailure(facts))
        return {
          seatName,
          kind: "not_started",
          detail: `recording its home and placement failed: ${detailOf(facts.failure)}`,
        } satisfies CrewSeatLaunchOutcome;
      return { seatName, kind: "created" } satisfies CrewSeatLaunchOutcome;
    });

    /**
     * Create each seat's thread and commit its home and placement, carrying on past a seat that
     * fails. A failed create is checked against the store: only a thread that never came to exist
     * is `not_created`; one that exists without its home is `not_started`.
     */
    const spawnSeats = Effect.fn("j5.a2a.crewLaunch.spawnSeats")(function* (
      captain: CrewCaptain,
      planned: ReadonlyArray<Planned>,
    ) {
      const outcomes: Array<CrewSeatLaunchOutcome> = [];
      const created: Array<Planned> = [];
      for (const member of planned) {
        const seatName = member.seat.name;
        // Seats go through the same start guard as j5_spawn_agent (see `withSpawnStart`), so every
        // door that creates a spawn thread keeps its invariant. A Crew's launches are already
        // serialized, so its in-flight refusal is not expected here. Their first assignments arrive
        // separately.
        const started = yield* Effect.result(
          spawnWorkspace.withSpawnStart(
            {
              stableInput: member.stableInput,
              threadId: member.threadId,
            },
            startSeat(captain, member),
          ),
        );
        if (Result.isFailure(started)) {
          outcomes.push({ seatName, kind: "not_started", detail: detailOf(started.failure) });
          continue;
        }
        outcomes.push(started.success);
        if (started.success.kind === "created") created.push(member);
      }
      return { outcomes, created };
    });

    const sql = yield* SqlClient.SqlClient;
    const encodeWorkspace = Schema.encodeEffect(Schema.fromJsonString(CrewSeatWorkspace));
    const prepareBriefs = Effect.fn("j5.a2a.crewLaunch.prepareBriefs")(function* (
      captain: CrewCaptain,
      instance: AgentCrewInstance,
      planned: ReadonlyArray<Planned>,
      brief: string,
      playbook: CrewLaunchPlaybook | null,
    ) {
      const roster = instance.members.map((member) => ({
        seat: member.seatName,
        participantId: member.participantId,
        reason: member.reason,
        agentDisplayName:
          planned.find((entry) => entry.seat.name === member.seatName)?.agentDisplayName ??
          member.agentId ??
          "custom",
      }));
      for (const member of planned) {
        const text = spawnFirstTurnText({
          brief: withReviewIndependenceNote(brief, member.assignment),
          participantId: member.participantId,
          projectId: captain.projectId,
          projectTitle: captain.projectTitle,
          spawnedByParticipantId: captain.participantId,
          spawnerThreadId: captain.thread.id,
          crew: {
            displayName: instance.displayName,
            instanceId: instance.id,
            seatName: member.seat.name,
            seatInstructions: member.seat.instructions,
            captainParticipantId: captain.participantId,
            roster,
            playbook:
              playbook === null
                ? undefined
                : {
                    name: playbook.name,
                    title: playbook.title,
                    steps: playbook.steps.filter((step) => member.seat.steps?.includes(step.id)),
                  },
          },
        });
        const workspaceJson = yield* encodeWorkspace(member.workspace);
        yield* sql`
          INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace, agent_display_name)
          VALUES (${member.threadId}, ${text}, ${workspaceJson}, ${member.agentDisplayName})
          ON CONFLICT (thread_id) DO NOTHING
        `;
      }
    });

    /**
     * Create the reserved seats with their approved context, then drop seats that were never created.
     * Every seat is attempted; the outcomes say what became of each.
     */
    const spawnAndBrief = Effect.fn("j5.a2a.crewLaunch.spawnAndBrief")(function* (
      captain: CrewCaptain,
      instance: AgentCrewInstance,
      planned: ReadonlyArray<Planned>,
      brief: string,
      playbook: CrewLaunchPlaybook | null,
      addition: boolean,
      /** False when nothing was reserved, so there is no row to drop for a seat never created. */
      reserved = true,
    ) {
      yield* prepareBriefs(captain, instance, planned, brief, playbook).pipe(
        Effect.mapError(
          (cause) =>
            new CrewLaunchOperationError({
              phase: "prepare seat context",
              seatName: null,
              createdSeats: [],
              cause,
            }),
        ),
      );
      const spawned = yield* spawnSeats(captain, planned);
      const notCreated = spawned.outcomes.flatMap((outcome) =>
        outcome.kind === "not_created" ? [outcome.seatName] : [],
      );
      // A row the store refused to delete is dropped by the launch report, which removes every
      // row this proposal minted whose thread does not exist before it measures the seats.
      if (reserved && notCreated.length > 0)
        yield* crews.removeMembers(instance.id, notCreated).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 crew launch could not drop seats that were never created", {
              crewInstanceId: instance.id,
              seats: notCreated,
              cause,
            }),
          ),
        );
      const seats = spawned.outcomes;
      const outcomes = (kind: CrewSeatLaunchOutcome["kind"]) =>
        seats.filter((seat) => seat.kind === kind).length;
      yield* recordAnalytics("j5.crew.launched", {
        addition,
        seats: planned.length,
        personaSeats: planned.filter((member) => member.assignment !== null).length,
        worktreeSeats: planned.filter((member) => member.workspace.type === "worktree").length,
        fullAccessSeats: planned.filter((member) => member.runtimeMode === "full-access").length,
        models: new Set(planned.map((member) => member.modelSelection.model)).size,
        hasPlaybook: playbook !== null,
        created: outcomes("created"),
        notCreated: outcomes("not_created"),
        notStarted: outcomes("not_started"),
      });
      return {
        instance: (yield* crews.read(instance.id).pipe(Effect.orElseSucceed(() => null))) ?? {
          ...instance,
          members: instance.members.filter((member) => !notCreated.includes(member.seatName)),
        },
        seats,
      } satisfies CrewLaunchResult;
    });

    const launch: CrewLaunchServiceShape["launch"] = Effect.fn("j5.a2a.crewLaunch.launch")(
      function* (input) {
        const resolved =
          input.resolvedSeats ?? (yield* resolveSeats(input.captain, input.seats, input.pick));
        yield* spendAllowances(resolved);
        const planned = plan(input.providerSessionId, input.requestKey, resolved);
        const recordError = (phase: string) => (cause: unknown) =>
          new CrewLaunchOperationError({ phase, seatName: null, createdSeats: [], cause });
        const crewInstanceId = spawnCrewInstanceId({
          providerSessionId: input.providerSessionId,
          requestKey: input.requestKey,
        });
        // An approval whose link or resolution failed recorded the Crew and spawned nothing. If
        // the person renamed seats before approving again, the earlier names are still on the
        // record with no thread behind them; drop them so the record holds only this roster.
        const earlier = yield* crews
          .read(crewInstanceId)
          .pipe(Effect.mapError(recordError("reading the earlier record")));
        const stale = (earlier?.members ?? []).filter(
          (member) => !planned.some((entry) => entry.seat.name === member.seatName),
        );
        if (stale.length > 0)
          yield* crews
            .removeMembers(
              crewInstanceId,
              stale.map((member) => member.seatName),
            )
            .pipe(Effect.mapError(recordError("releasing renamed seats")));
        // Record the unit before any seat exists: every planned seat is named under its
        // deterministic ids, and a member's own crew request is refused from its first turn.
        const instance = yield* crews
          .record({
            id: crewInstanceId,
            projectId: input.captain.projectId,
            captainParticipantId: input.captain.participantId,
            captainThreadId: input.captain.thread.id,
            displayName: input.displayName,
            brief: input.brief,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            playbook:
              input.playbook == null
                ? null
                : { name: input.playbook.name, definitionPath: input.playbook.definitionPath },
            members: planned.map((member) => ({
              seatName: member.seat.name,
              agentId: member.seat.agentId,
              participantId: member.participantId,
              threadId: member.threadId,
              reason: member.seat.reason,
              playbookStepIds: member.seat.steps,
            })),
          })
          .pipe(Effect.mapError(unlessStepOwned(recordError("recording the crew"))));
        if (input.onRecorded !== undefined) yield* input.onRecorded(instance);
        return yield* spawnAndBrief(
          input.captain,
          instance,
          planned,
          input.brief,
          input.playbook ?? null,
          false,
        );
      },
      (launch, input) =>
        // One unit step from the record through creation, so a unit archive waits for every
        // seat to exist before it reads the roster.
        crews.serialize(
          spawnCrewInstanceId({
            providerSessionId: input.providerSessionId,
            requestKey: input.requestKey,
          }),
          launch,
        ),
    );

    /**
     * Launch one seat in place of a live one, holding the Crew's lock like any addition. Checked
     * again here under the lock; the swap is one store write after the seat's thread exists. Until
     * then it is no member, and a seat that is no member takes no message, so nothing reaches it.
     */
    const replaceSeat = Effect.fn("j5.a2a.crewLaunch.replaceSeat")(function* (
      input: CrewAddSeatsInput,
      replacement: CrewSeatReplacement,
      planned: ReadonlyArray<Planned>,
    ) {
      const failed = (phase: string) => (cause: unknown) =>
        new CrewLaunchOperationError({ phase, seatName: null, createdSeats: [], cause });
      const requested = planned[0];
      if (requested === undefined || planned.length !== 1)
        return yield* failed("replacing a seat")("a replacement launches exactly one seat");
      const current = yield* crews
        .read(input.instance.id)
        .pipe(Effect.mapError(failed("reading the crew")));
      if (current === null)
        return yield* failed("replacing a seat")(`crew ${input.instance.id} no longer exists`);
      // Refusals, as the request's own checks would have refused it: nothing has spawned yet.
      const refused = (detail: string) =>
        new CrewLaunchSeatUnavailableError({
          seatName: requested.seat.name,
          agentId: requested.seat.agentId ?? "custom seat",
          detail,
        });
      const problem = replacementProblem(current, replacement.seatName, requested.seat.name);
      if (problem !== null) return yield* refused(problem);
      const old = current.members.find(({ seatName }) => seatName === replacement.seatName)!;
      const movedStepIds = yield* replacement.unfinishedSteps(current);
      // Its brief and its row list the steps it takes over beside any it claimed itself.
      const steps = [...new Set([...(requested.seat.steps ?? []), ...movedStepIds])];
      const member = { ...requested, seat: { ...requested.seat, steps } };
      const newMember = {
        seatName: member.seat.name,
        agentId: member.seat.agentId,
        participantId: member.participantId,
        threadId: member.threadId,
        reason: member.seat.reason,
        playbookStepIds: steps,
      };
      // A step another addition claimed since the request was checked refuses it before it spawns.
      const owned = stepOwnershipConflict(
        current.id,
        current.members.filter(({ seatName }) => seatName !== old.seatName),
        [newMember],
      );
      if (owned !== null) return yield* owned;
      const oldThread = yield* getThreadRecordsIfPresent(threadManagement, old.threadId, []).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (input.onReserved !== undefined) yield* input.onReserved(current);
      // The brief's roster reads as it will once the swap lands.
      const briefed = {
        ...current,
        members: current.members.map((seat) =>
          seat.seatName === old.seatName
            ? { ...newMember, addedVersion: current.version + 1 }
            : seat,
        ),
      };
      const launched = yield* spawnAndBrief(
        input.captain,
        briefed,
        [member],
        `${input.brief ?? current.brief}\n\n${crewReplacementLine({
          seatName: old.seatName,
          model: oldThread?.thread.modelSelection.model ?? null,
          threadId: old.threadId,
        })}`,
        input.playbook ?? null,
        true,
        false,
      );
      if (launched.seats.some((seat) => seat.kind !== "created")) {
        // A thread that exists without its home is no member and takes no message; it is archived
        // so nothing is left beside the seat it failed to replace.
        if (launched.seats.some((seat) => seat.kind === "not_started"))
          yield* threadManagement
            .dispatch({
              type: "thread.archive",
              commandId: lifecycleCommandId({
                ...member.stableInput,
                operation: "replacement-not-started",
              }),
              threadId: member.threadId,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "J5 crew replacement could not archive a seat that didn't start",
                  {
                    crewInstanceId: current.id,
                    threadId: member.threadId,
                    cause,
                  },
                ),
              ),
            );
        return { instance: current, seats: launched.seats } satisfies CrewLaunchResult;
      }
      const swapped = yield* crews
        .replaceMember(current.id, {
          seatName: old.seatName,
          participantId: old.participantId,
          member: newMember,
          movedStepIds,
          replacedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.mapError(unlessStepOwned(failed("swapping in the replacement"))));
      if (swapped.status !== "replaced")
        return yield* failed("swapping in the replacement")(
          swapped.status === "missing" ? `crew ${current.id} no longer exists` : swapped.detail,
        );
      return { instance: swapped.instance, seats: launched.seats } satisfies CrewLaunchResult;
    });

    // One unit step from the reservation through the briefs, like a launch.
    const addSeats: CrewLaunchServiceShape["addSeats"] = Effect.fn("j5.a2a.crewLaunch.addSeats")(
      function* (input) {
        const resolved =
          input.resolvedSeats ??
          (yield* resolveSeats(input.captain, input.seats, input.pick, input.instance));
        yield* spendAllowances(resolved);
        const planned = plan(input.providerSessionId, input.requestKey, resolved);
        if (input.replacement !== undefined)
          return yield* replaceSeat(input, input.replacement, planned);
        // Reserve the seats before anything spawns: the store decides the cap and the version in
        // one transaction, so two approvals landing together cannot both pass.
        const reservation = yield* crews
          .addMembers(
            input.instance.id,
            planned.map((member) => ({
              seatName: member.seat.name,
              agentId: member.seat.agentId,
              participantId: member.participantId,
              threadId: member.threadId,
              reason: member.seat.reason,
              playbookStepIds: member.seat.steps,
            })),
            { maxSeats: CREW_SEAT_CAP },
          )
          .pipe(
            Effect.mapError(
              unlessStepOwned(
                (cause) =>
                  new CrewLaunchOperationError({
                    phase: "reserving the added seats",
                    seatName: null,
                    createdSeats: [],
                    cause,
                  }),
              ),
            ),
          );
        if (reservation.status === "missing" || reservation.instance === null)
          return yield* new CrewLaunchOperationError({
            phase: "reserving the added seats",
            seatName: null,
            createdSeats: [],
            cause: `crew ${input.instance.id} no longer exists`,
          });
        if (reservation.status === "archived")
          return yield* new CrewLaunchOperationError({
            phase: "reserving the added seats",
            seatName: null,
            createdSeats: [],
            cause: `crew ${input.instance.id} is retired`,
          });
        if (reservation.status === "conflict")
          return yield* new CrewLaunchSeatConflictError({
            crewInstanceId: input.instance.id,
            seatNames: reservation.conflicts,
          });
        if (reservation.status === "cap-exceeded")
          return yield* new CrewLaunchCapError({
            crewInstanceId: input.instance.id,
            held: reservation.instance.members.length,
            adding: planned.length,
            cap: CREW_SEAT_CAP,
          });
        const reserved = reservation.instance;
        if (input.onReserved !== undefined)
          yield* input.onReserved(reserved).pipe(
            // Nothing spawned: release the rows so the same request can be approved again.
            Effect.tapError(() =>
              crews
                .removeMembers(
                  reserved.id,
                  planned.map((member) => member.seat.name),
                )
                .pipe(Effect.ignore),
            ),
          );
        return yield* spawnAndBrief(
          input.captain,
          reserved,
          planned,
          input.brief ?? reserved.brief,
          input.playbook ?? null,
          true,
        );
      },
      (addition, input) => crews.serialize(input.instance.id, addition),
    );

    // Only the card's select lists; every seat's workspace is bound from a fresh read above, at
    // preview and again at approval, where the token refuses a launch that no longer matches.
    const workspaceOptions: CrewLaunchServiceShape["workspaceOptions"] = (captain) =>
      spawnWorkspace.workspaceOptions({
        projectId: captain.thread.projectId,
        worktreePath: captain.thread.worktreePath,
      });

    return CrewLaunchService.of({
      launch,
      addSeats,
      resolveSeats,
      pinWorkspaces,
      workspaceOptions,
    });
  }),
);

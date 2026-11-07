import type {
  CrewPersonaSwap,
  CrewProposalPreviewRequest,
  CrewProposalPreviewResponse,
  PlaybookError,
  PlaybookReadResponse,
} from "@t3tools/contracts/j5";
import { crewApprovalToken, crewPlaybookPlanDigest } from "./crewRuntimePreview.ts";
import { MessageId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as ServerSettings from "../../serverSettings.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { personaBlockText } from "../agents/agentPersonaEscalation.ts";
import { findAgentPersonaDefinition } from "../agents/agentPersonaLaunch.ts";
import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { makePlaybookCrewRelay } from "../playbooks/PlaybookCrewRelay.ts";
import {
  AgentCrewInstanceService,
  replacementProblem,
  type AgentCrewInstance,
} from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  type CrewPlaybookRef,
  type CrewProposal,
  type CrewProposalSeat,
  type CreateCrewProposalInput,
} from "./AgentCrewProposalService.ts";
import {
  CREW_SEAT_CAP,
  CrewLaunchOperationError,
  CrewLaunchSeatUnavailableError,
  CrewLaunchService,
  type CrewCaptain,
  type CrewLaunchError,
  type CrewLaunchPlaybook,
  type CrewLaunchSeat,
  type CrewSeatPick,
  type CrewSeatReplacement,
  type ResolvedCrewLaunchSeat,
} from "./CrewLaunchService.ts";
import { planCrewPlaybook, withPersonaSwaps, type CrewPlaybookPlan } from "./crewPlaybookPlan.ts";
import { crewDeclinedNoticeText, crewRosterChanges } from "./crewGateNotice.ts";
import { j5AnalyticsRecorder } from "../analytics/recorder.ts";
import { CrewLaunchReporter } from "./CrewLaunchReporter.ts";
import { crewSeatShapeProblem } from "./crewLimits.ts";
import { CREW_PROPOSAL_SESSION, crewSeatThreadId } from "./crewSeatIds.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { AGENT_STOP_REASON, stopThread } from "./stopThread.ts";
import { A2ALedger } from "./LedgerService.ts";
import { lifecycleCommandId, lifecycleId } from "./spawnIds.ts";
import type { ResolvedSpawnWorkspace, SpawnWorkspaceChoice } from "./spawnWorkspace.ts";
import { requestDigest, requestReplayConflict } from "./RequestReplayService.ts";
import { worktreePathKey } from "./spawnWorkspace.ts";
import { getThreadRecordsIfPresent } from "./threadProjectionReads.ts";

/** Hard cap on seats per Crew, initial roster and additions together. */
export { CREW_SEAT_CAP } from "./CrewLaunchService.ts";

const PROPOSAL_SESSION = CREW_PROPOSAL_SESSION;

/**
 * A proposal seat as the launcher takes it. `validateSeats` refuses a seat with no workspace before
 * any preview or launch, so one reaching here without it is a bug, not a request.
 */
const launchSeatOf = (seat: CrewProposalSeat): CrewLaunchSeat => {
  if (seat.workspace === undefined)
    throw new Error(`Seat ${seat.seat} reached the launcher without a workspace.`);
  return {
    name: seat.seat,
    agentId: seat.agentId,
    reason: seat.reason,
    instructions: seat.instructions,
    personaInstructions: seat.personaInstructions,
    modelSelection: seat.modelSelection,
    runtimeMode: seat.runtimeMode,
    steps: seat.steps,
    reviews: seat.reviews,
    workspace: seat.workspace,
    allowOnce: seat.allowOnce,
  };
};

class CrewProposalRequestError extends Data.TaggedError("CrewProposalRequestError")<{
  readonly detail: string;
  readonly nextStep: string;
}> {
  override get message(): string {
    return `${this.detail} ${this.nextStep}`;
  }
}

export class CrewProposalNotOpenError extends Data.TaggedError("CrewProposalNotOpenError")<{
  readonly proposalId: string;
  readonly status: string;
}> {
  override get message(): string {
    return `Proposal ${this.proposalId} is ${this.status}, not open; nothing was changed.`;
  }
}

class CrewProposalNotFoundError extends Data.TaggedError("CrewProposalNotFoundError")<{
  readonly proposalId: string;
}> {
  override get message(): string {
    return `Proposal ${this.proposalId} does not exist in this environment.`;
  }
}

class CrewProposalOperationError extends Data.TaggedError("CrewProposalOperationError")<{
  readonly phase: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Crew proposal failed while ${this.phase}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

export type CrewProposalError =
  | CrewProposalRequestError
  | CrewProposalNotOpenError
  | CrewProposalNotFoundError
  | CrewProposalOperationError
  | CrewLaunchError;

export interface ProposeCrewInput {
  readonly requestKey: string;
  readonly captain: CrewCaptain;
  readonly displayName: string;
  readonly brief: string;
  readonly seats: ReadonlyArray<CrewProposalSeat>;
  /** The playbook the Crew follows, by name in the Captain's workspace. */
  readonly playbook?: { readonly name: string; readonly workspaceRoot: string } | undefined;
}

export interface RequestCrewMemberInput {
  readonly requestKey: string;
  readonly captain: CrewCaptain;
  readonly crewInstanceId: string | null;
  readonly seat: CrewProposalSeat;
  /** The brief the new seat starts on; the Crew's brief when omitted. */
  readonly brief: string | null;
}

export interface ResolveCrewProposalInput {
  readonly proposalId: string;
  readonly decision: "approve" | "decline";
  readonly approvalToken?: string | undefined;
  /** The human's final roster on approval; the requested seats when omitted. */
  readonly seats?: ReadonlyArray<CrewProposalSeat> | undefined;
  /** Who is answering, as the Captain is told; given only for a shared conversation. */
  readonly decidedBy?: string | null | undefined;
}

/** What the Captain is told about a playbook proposal it just filed. */
export interface CrewProposalPlaybookOutcome {
  readonly name: string;
  readonly title: string;
  readonly unownedSteps: ReadonlyArray<string>;
  readonly swaps: ReadonlyArray<{ readonly seat: string; readonly swap: CrewPersonaSwap }>;
}

export interface CrewProposalOutcome {
  readonly proposal: CrewProposal;
  readonly instance: AgentCrewInstance | null;
  /** Present when this call validated a proposal that follows a playbook. */
  readonly playbook?: CrewProposalPlaybookOutcome | null | undefined;
}

export interface CrewProposalServiceShape {
  readonly preview: (
    input: CrewProposalPreviewRequest,
  ) => Effect.Effect<CrewProposalPreviewResponse, CrewProposalError>;
  readonly propose: (
    input: ProposeCrewInput,
  ) => Effect.Effect<CrewProposalOutcome, CrewProposalError>;
  readonly requestMember: (
    input: RequestCrewMemberInput,
  ) => Effect.Effect<CrewProposalOutcome, CrewProposalError>;
  /**
   * Resolves a proposal once. A decline is told to the Captain and recorded. An approval records
   * the Crew, resolves the proposal, then attempts every seat; the launch report tells the
   * Captain what became of each, including seats that were never created.
   */
  readonly resolve: (
    input: ResolveCrewProposalInput,
  ) => Effect.Effect<CrewProposalOutcome, CrewProposalError>;
}

export class CrewProposalService extends Context.Service<
  CrewProposalService,
  CrewProposalServiceShape
>()("t3/j5/a2a/CrewProposalService") {}

const seatNamesUnique = (seats: ReadonlyArray<CrewProposalSeat>) =>
  new Set(seats.map(({ seat }) => seat)).size === seats.length;

type PlannedPlaybook = Extract<CrewPlaybookPlan, { readonly problem: null }>;

const playbookOutcome = (plan: PlannedPlaybook): CrewProposalPlaybookOutcome | null =>
  plan.summary === null
    ? null
    : {
        name: plan.summary.name,
        title: plan.summary.title,
        unownedSteps: plan.unownedSteps,
        swaps: [...plan.swapsBySeat].flatMap(([seat, swaps]) =>
          swaps.map((swap) => ({ seat, swap })),
        ),
      };

/** The token binds this digest, so a live edit the card has not shown refuses the approval. */
const planDigest = (playbook: CrewPlaybookRef | null | undefined, plan: PlannedPlaybook) =>
  playbook == null || plan.summary === null
    ? undefined
    : crewPlaybookPlanDigest({
        definitionPath: playbook.definitionPath,
        summary: plan.summary,
        swapsBySeat: plan.swapsBySeat,
        unownedSteps: plan.unownedSteps,
      });

/**
 * The playbook a launch records and briefs. Without a readable definition (possible only when no
 * seat claims a step) the Crew still records it, and each brief says the seat owns no steps.
 */
const launchPlaybook = (
  playbook: CrewPlaybookRef | null | undefined,
  definition: PlaybookReadResponse | null,
): CrewLaunchPlaybook | null =>
  playbook == null
    ? null
    : {
        name: playbook.name,
        definitionPath: playbook.definitionPath,
        title: definition?.title ?? playbook.name,
        steps: (definition?.steps ?? []).map(({ id, title }) => ({ id, title })),
      };

const claimsSteps = (seats: ReadonlyArray<CrewProposalSeat>) =>
  seats.some((seat) => (seat.steps?.length ?? 0) > 0);

const memberSteps = (instance: AgentCrewInstance | null) =>
  (instance?.members ?? []).map((member) => ({
    seatName: member.seatName,
    playbookStepIds: member.playbookStepIds ?? [],
  }));

/** The live seats these seats take over. */
const replacedSeatNames = (seats: ReadonlyArray<CrewProposalSeat>) =>
  seats.flatMap((seat) => (seat.replaces === undefined ? [] : [seat.replaces]));

/** The Crew as a replacement joins it: the seats it takes over have already left. */
const withoutReplaced = (instance: AgentCrewInstance, seats: ReadonlyArray<CrewProposalSeat>) => {
  const leaving = replacedSeatNames(seats);
  return {
    ...instance,
    members: instance.members.filter((member) => !leaving.includes(member.seatName)),
  };
};

/** Seats a reviewer may name besides the live ones: those replaced, or being replaced now. */
const formerSeatNames = (instance: AgentCrewInstance, seats: ReadonlyArray<CrewProposalSeat>) => [
  ...(instance.replaced ?? []).map((member) => member.seatName),
  ...replacedSeatNames(seats),
];

const omitBaseCommit = ({
  baseCommit: _pin,
  ...workspace
}: Extract<SpawnWorkspaceChoice, { readonly type: "worktree" }>) => workspace;

/** The seats with each new worktree's commit saved in its choice, from the workspaces resolved for them. */
const withBaseCommits = (
  seats: ReadonlyArray<CrewProposalSeat>,
  workspaces: ReadonlyArray<SpawnWorkspaceChoice | ResolvedSpawnWorkspace>,
): ReadonlyArray<CrewProposalSeat> =>
  seats.map((seat, index) => {
    const resolved = workspaces[index];
    return seat.workspace?.type === "worktree" &&
      resolved?.type === "worktree" &&
      resolved.baseCommit !== undefined
      ? { ...seat, workspace: { ...seat.workspace, baseCommit: resolved.baseCommit } }
      : seat;
  });

/** Whether the person changed a seat's workspace; `crewRosterChanges` leaves workspaces out. */
const sameWorkspace = (a: CrewProposalSeat["workspace"], b: CrewProposalSeat["workspace"]) => {
  if (a === undefined || b === undefined) return a === b;
  switch (a.type) {
    case "shared":
      return b.type === "shared";
    case "worktree":
      return (
        b.type === "worktree" &&
        a.baseRef === b.baseRef &&
        a.branch === b.branch &&
        (a.startFromOrigin ?? false) === (b.startFromOrigin ?? false)
      );
    case "existing_worktree":
      return (
        b.type === "existing_worktree" &&
        worktreePathKey(a.worktreePath) === worktreePathKey(b.worktreePath)
      );
  }
};

const rosterEdited = (
  requested: ReadonlyArray<CrewProposalSeat>,
  approved: ReadonlyArray<CrewProposalSeat>,
) =>
  Object.values(crewRosterChanges(requested, approved)).some((changed) => changed.length > 0) ||
  approved.some((seat) => {
    const asked = requested.find(({ seat: name }) => name === seat.seat);
    return asked !== undefined && !sameWorkspace(asked.workspace, seat.workspace);
  });

type ProposalRequest = Omit<CreateCrewProposalInput, "playbook"> & {
  readonly playbook?: Pick<CrewPlaybookRef, "name"> | null | undefined;
};

// Proposal rows preserve original intent across upgrades; human edits go to approvedSeats.
const proposalRequest = (proposal: ProposalRequest) => ({
  projectId: proposal.projectId,
  captainParticipantId: proposal.captainParticipantId,
  captainThreadId: proposal.captainThreadId,
  kind: proposal.kind,
  crewInstanceId: proposal.kind === "addition" ? proposal.crewInstanceId : null,
  brief: proposal.brief,
  displayName: proposal.displayName,
  playbook: proposal.playbook?.name ?? null,
  seats: proposal.requestedSeats.map(({ personaSwaps: _swaps, workspace, ...seat }) => ({
    ...seat,
    steps: seat.steps ?? [],
    // The server saves the pin after the request; a retry never carries it.
    workspace:
      workspace?.type === "worktree"
        ? {
            ...omitBaseCommit(workspace),
            startFromOrigin: workspace.startFromOrigin ?? false,
          }
        : workspace?.type === "existing_worktree"
          ? { ...workspace, worktreePath: worktreePathKey(workspace.worktreePath) }
          : workspace,
  })),
});

export const layer = Layer.effect(
  CrewProposalService,
  Effect.gen(function* () {
    const proposals = yield* AgentCrewProposalService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const crews = yield* AgentCrewInstanceService;
    const launcher = yield* CrewLaunchService;
    const reporter = yield* CrewLaunchReporter;
    const recordAnalytics = yield* j5AnalyticsRecorder;
    /**
     * The person's decision, as `feature.used`. Recorded here, not from the RPC, because only
     * the proposal tells an edited roster from the one the Captain asked for. An automatic
     * approval is no person's action, so it records nothing.
     */
    const recordResolved = Effect.fn("j5.a2a.crewProposal.recordResolved")(function* (
      proposal: CrewProposal,
      approved: ReadonlyArray<CrewProposalSeat> | null,
    ) {
      if (proposal.approvalMode === "automatic") return;
      yield* recordAnalytics("feature.used", {
        feature: "crew.proposal.resolve",
        variant:
          approved === null
            ? "decline"
            : rosterEdited(proposal.requestedSeats, approved)
              ? "edit"
              : "approve",
      });
    });
    const threadManagement = yield* ThreadManagementService;
    const ledger = yield* A2ALedger;
    const agents = yield* makeAgentPersonaLibrary;
    const playbooks = yield* PlaybookStore;
    // One resolution of a proposal at a time on this server, so an approval and a decline from
    // two devices cannot interleave; the store's compare-and-set from open decides the winner.
    const gates = yield* KeyedLock.make<string>();

    const operationError = (phase: string) => (cause: unknown) =>
      new CrewProposalOperationError({ phase, cause });

    /** The one refusal for an addition past the cap, whether filed or approved. */
    const crewFullError = (
      displayName: string,
      held: number,
      adding: number,
      kind: "request" | "approval",
    ) =>
      new CrewProposalRequestError({
        detail:
          kind === "request"
            ? `Crew ${displayName} is full: it holds ${held} of ${CREW_SEAT_CAP} seats counting requests still open, and this request adds ${adding}.`
            : `Crew ${displayName} is full: it holds ${held} of ${CREW_SEAT_CAP} seats, and this approval adds ${adding}.`,
        nextStep:
          "A member finishing frees no seat. Work with the seats this crew has, or propose a new crew for the extra hands.",
      });

    /**
     * A playbook the Crew cannot follow, told to whoever is at the door: the Captain naming one
     * to propose, the Captain adding a seat to a Crew that follows one, or the person approving.
     */
    const playbookRefusal =
      (name: string, door: "propose" | "crew" | "approval") => (error: PlaybookError) =>
        door === "approval"
          ? new CrewProposalRequestError({
              detail:
                error.code === "not_found"
                  ? `Playbook ${name} can no longer be read: its file is gone from the Captain's workspace.`
                  : `Playbook ${name} can no longer be read: ${error.message}`,
              nextStep:
                "Ask the Captain to fix the playbook and propose again, or decline this proposal.",
            })
          : door === "crew"
            ? new CrewProposalRequestError({
                detail:
                  error.code === "not_found"
                    ? `Playbook ${name}, which this crew follows, can no longer be read: its file is gone from the Captain's workspace.`
                    : `Playbook ${name}, which this crew follows, can no longer be read: ${error.message}`,
                nextStep: "Restore or fix the playbook file, or request the seat without steps.",
              })
            : error.code === "not_found" || error.code === "invalid_name"
              ? new CrewProposalRequestError({
                  detail: `No playbook named ${name} in your workspace.`,
                  nextStep: "Call j5_playbook_list and pass a name it returns.",
                })
              : new CrewProposalRequestError({
                  detail: `Playbook ${name} cannot be followed: ${error.message}`,
                  nextStep:
                    "Fix the definition until j5_playbook_list lists it without an issue, then retry.",
                });

    /** The live definition; a Crew's plan is always checked against the YAML as it is now. */
    const readPlaybook = (playbook: CrewPlaybookRef, door: "propose" | "crew" | "approval") =>
      playbooks
        .readPath(playbook.definitionPath)
        .pipe(Effect.mapError(playbookRefusal(playbook.name, door)));

    /**
     * A followed Crew's definition for seats joining it. Only a seat claiming steps needs it, so
     * a missing or broken file refuses only those; other seats go ahead without live titles.
     */
    const readFollowed = (
      playbook: CrewPlaybookRef | null | undefined,
      seats: ReadonlyArray<CrewProposalSeat>,
      door: "crew" | "approval",
    ) =>
      playbook == null
        ? Effect.succeed(null)
        : claimsSteps(seats)
          ? readPlaybook(playbook, door)
          : playbooks.readPath(playbook.definitionPath).pipe(Effect.orElseSucceed(() => null));

    /**
     * Persona seats must name known, enabled personas; the library is the source of truth, not the
     * Captain. A custom seat names none and is checked for shape only. A playbook Crew's seats
     * must claim existing steps, one owner each.
     */
    const validateSeats = Effect.fn("j5.a2a.crewProposal.validateSeats")(function* (
      seats: ReadonlyArray<CrewProposalSeat>,
      /** The live Crew's seat names for an addition; null for a new roster. */
      existingSeatNames: ReadonlyArray<string> | null,
      humanReview = false,
      playbook: {
        readonly definition: PlaybookReadResponse;
        readonly existingMembers: ReturnType<typeof memberSteps>;
      } | null = null,
      /** Replaced seats an addition's reviewer may still name: their work is in the Crew's. */
      formerSeats: ReadonlyArray<string> = [],
    ) {
      if (seats.length === 0)
        return yield* new CrewProposalRequestError({
          detail: "A crew request needs at least one seat.",
          nextStep: "Call j5_list_personas, then propose seats with a reason each.",
        });
      // The MCP schema already bounds a Captain's seats; the human's card submits the same shape
      // through HTTP, so every door meets the rule here rather than surfacing a storage error.
      for (const seat of seats) {
        if (
          !humanReview &&
          seat.agentId !== null &&
          (seat.modelSelection !== undefined || seat.runtimeMode !== undefined)
        )
          return yield* new CrewProposalRequestError({
            detail: `Seat ${seat.seat} is a saved persona; only the human can override its runtime.`,
            nextStep:
              "Propose the persona with its defaults; the human may edit its runtime before approval.",
          });
        const problem = crewSeatShapeProblem(seat);
        if (problem !== null)
          return yield* new CrewProposalRequestError({
            detail: `Seat "${seat.seat}": ${problem.detail}`,
            nextStep: `Correct the seat's ${problem.field} and retry.`,
          });
      }
      if (!seatNamesUnique(seats))
        return yield* new CrewProposalRequestError({
          detail: "Seat names must be unique within a crew.",
          nextStep: "Rename the duplicate seats and retry.",
        });
      // The person's card may rename a seat a reviewer names; that name is dropped at launch, and
      // a reviewer left with none reviews the default authors.
      if (!humanReview)
        for (const seat of seats) {
          const unknown = seat.reviews?.find(
            (name) =>
              name === seat.seat ||
              !(
                seats.some((other) => other.seat === name) ||
                existingSeatNames?.includes(name) ||
                formerSeats.includes(name)
              ),
          );
          if (unknown !== undefined)
            return yield* new CrewProposalRequestError({
              detail: `Seat ${seat.seat} reviews "${unknown}", which is not ${unknown === seat.seat ? "another seat" : "a seat on this crew"}.`,
              nextStep: "Name other seats or members of this crew in reviews, or omit it.",
            });
        }
      const taken = seats.find((seat) => existingSeatNames?.includes(seat.seat));
      if (taken !== undefined)
        return yield* new CrewProposalRequestError({
          detail: `The crew already has a seat named ${taken.seat}.`,
          nextStep: "Choose a different seat name.",
        });
      if (existingSeatNames === null && seats.length > CREW_SEAT_CAP)
        return yield* new CrewProposalRequestError({
          detail: `A crew may hold at most ${CREW_SEAT_CAP} seats; this roster names ${seats.length}.`,
          nextStep: `Keep the roster to ${CREW_SEAT_CAP} seats; a second crew is how you get more hands.`,
        });
      const catalog = yield* agents
        .catalog()
        .pipe(Effect.mapError(operationError("reading the agent library")));
      // A persona that can't be found is refused here, before anything is filed, with the
      // same code and text its launch would give (an invalid one with its repair message).
      const library = { ...agents, catalog: () => Effect.succeed(catalog) };
      for (const seat of seats) {
        const agentId = seat.agentId;
        if (agentId === null) continue;
        const refused = yield* findAgentPersonaDefinition(agentId, library).pipe(
          Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
        );
        if (refused !== null)
          return yield* new CrewLaunchSeatUnavailableError({
            seatName: seat.seat,
            agentId,
            detail: personaBlockText({
              code: refused.code ?? "persona_not_found",
              detail: refused.message,
              escalationId: null,
              waivable: null,
            }),
            blockCode: refused.code ?? "persona_not_found",
          });
      }
      // Reviewers resolve after every other seat, so one can't see another reviewer's model.
      const isReviewer = (name: string) => {
        const agentId = seats.find((other) => other.seat === name)?.agentId;
        return catalog.definitions.some(
          ({ id, independentReviewer }) => id === agentId && independentReviewer === true,
        );
      };
      for (const seat of humanReview ? [] : seats) {
        const reviewer = seat.reviews?.find(isReviewer);
        if (reviewer !== undefined)
          return yield* new CrewProposalRequestError({
            detail: `Seat ${seat.seat} reviews "${reviewer}", another independent reviewer on this roster, whose model is chosen only after the seats it reviews.`,
            nextStep: "Name the seats whose work it reviews in reviews, not other reviewers.",
          });
      }
      const plan = planCrewPlaybook({
        definition: playbook?.definition ?? null,
        seats,
        existingMembers: playbook?.existingMembers ?? [],
        catalog,
      });
      if (plan.problem !== null) return yield* new CrewProposalRequestError(plan.problem);
      return plan;
    });

    /** The decline is told at once; an approval is told by the launch report, once the seats are up. */
    const notifyDeclined = Effect.fn("j5.a2a.crewProposal.notifyDeclined")(function* (
      proposal: CrewProposal,
    ) {
      const stable = { providerSessionId: PROPOSAL_SESSION, requestKey: proposal.id };
      const captain = yield* getThreadRecordsIfPresent(
        threadManagement,
        proposal.captainThreadId,
        [],
      ).pipe(Effect.mapError(operationError("reading the Captain thread")));
      // A deleted Captain takes no messages; the decline still has to go through, or the gate
      // it was refused at could never close.
      if (captain === null || captain.thread.deletedAt != null) return;
      yield* threadManagement
        .dispatch({
          type: "message.dispatch",
          createdBy: "system",
          creationSource: "server",
          commandId: lifecycleCommandId({ ...stable, operation: "proposal-notice" }),
          threadId: proposal.captainThreadId,
          messageId: MessageId.make(
            lifecycleId({ ...stable, kind: "message", operation: "proposal-notice" }),
          ),
          text: crewDeclinedNoticeText(proposal),
          attachments: [],
          modelSelection: captain.thread.modelSelection,
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.mapError(operationError("notifying the Captain")));
    });

    const captainFor = Effect.fn("j5.a2a.crewProposal.captainFor")(function* (
      proposal: CrewProposal,
    ) {
      const projection = yield* getThreadRecordsIfPresent(
        threadManagement,
        proposal.captainThreadId,
        [],
      ).pipe(Effect.mapError(operationError("reading the Captain thread")));
      // Checked at launch, not held: a Captain archived or deleted while its gate
      // is open is refused here, since new seats would be briefed to report to a participant
      // delivery no longer reaches. A Captain archived after this read is not caught.
      if (projection === null || projection.thread.deletedAt != null)
        return yield* new CrewProposalRequestError({
          detail: `Captain ${projection?.thread.title ?? proposal.captainParticipantId} has been deleted, so this crew has no one to command it.`,
          nextStep: "Decline this proposal.",
        });
      if (projection.thread.archivedAt !== null)
        return yield* new CrewProposalRequestError({
          detail: `Captain ${projection.thread.title} is archived, so this crew has no one to command it.`,
          nextStep: "Unarchive the Captain to approve it, or decline this proposal.",
        });
      const project = yield* ledger
        .readProjectLedger(proposal.projectId)
        .pipe(Effect.mapError(operationError("reading the project")));
      return {
        projectId: proposal.projectId,
        projectTitle: project.name,
        participantId: proposal.captainParticipantId,
        thread: projection.thread,
      } satisfies CrewCaptain;
    });

    /**
     * Resolves the proposal as approved, compare-and-set from open. It runs before any seat
     * spawns, so a proposal that launched can never be approved or declined again.
     */
    const recordApproval = Effect.fn("j5.a2a.crewProposal.recordApproval")(function* (
      proposal: CrewProposal,
      seats: ReadonlyArray<CrewProposalSeat>,
    ): Effect.fn.Return<void, CrewLaunchOperationError> {
      const failed = (cause: unknown) =>
        new CrewLaunchOperationError({
          phase: `approving proposal ${proposal.id}`,
          seatName: null,
          createdSeats: [],
          cause,
        });
      const approved = yield* proposals
        .resolve({
          id: proposal.id,
          decision: "approve",
          approvedSeats: seats,
          resolvedAt: DateTime.formatIso(yield* DateTime.now),
          decidedBy: proposal.decidedBy,
        })
        .pipe(Effect.mapError(failed));
      if (approved === null)
        return yield* failed(`proposal ${proposal.id} was no longer open, so nothing was launched`);
    });

    /**
     * Launch the approved seats: the Crew is recorded and linked, the proposal resolved, then every
     * seat is attempted. The proposal id keys every spawn.
     */
    const fulfil = Effect.fn("j5.a2a.crewProposal.fulfil")(function* (
      proposal: CrewProposal,
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewProposalSeat>,
      resolvedSeats: ReadonlyArray<ResolvedCrewLaunchSeat>,
      playbook: CrewLaunchPlaybook | null,
      pick: CrewSeatPick,
    ) {
      const launchSeats = seats.map(launchSeatOf);
      if (proposal.kind === "roster") {
        return yield* launcher.launch({
          providerSessionId: PROPOSAL_SESSION,
          requestKey: proposal.id,
          captain,
          displayName: proposal.displayName,
          seats: launchSeats,
          resolvedSeats,
          pick,
          brief: proposal.brief,
          playbook,
          // The launch report finds its Crew through this link, so a lost write fails the
          // approval before any seat spawns; recording is idempotent, so approving again is safe.
          onRecorded: (instance) =>
            proposals.attachInstance(proposal.id, instance.id).pipe(
              Effect.mapError(
                (cause) =>
                  new CrewLaunchOperationError({
                    phase: `linking proposal ${proposal.id} to crew ${instance.id}`,
                    seatName: null,
                    createdSeats: [],
                    cause,
                  }),
              ),
              Effect.andThen(recordApproval(proposal, seats)),
            ),
        });
      }
      const instance =
        proposal.crewInstanceId === null
          ? null
          : yield* crews
              .read(proposal.crewInstanceId)
              .pipe(Effect.mapError(operationError("reading the crew")));
      if (instance === null)
        return yield* new CrewProposalRequestError({
          detail: `Proposal ${proposal.id} adds to crew ${proposal.crewInstanceId}, which no longer exists.`,
          nextStep: "Decline this proposal.",
        });
      const replacing = seats.find((seat) => seat.replaces !== undefined);
      const replacement: CrewSeatReplacement | undefined =
        replacing?.replaces === undefined
          ? undefined
          : {
              seatName: replacing.replaces,
              unfinishedSteps: (crew) =>
                unfinishedSteps(crew, replacing.replaces!).pipe(
                  Effect.mapError((error) =>
                    error._tag === "CrewProposalRequestError"
                      ? new CrewLaunchSeatUnavailableError({
                          seatName: replacing.seat,
                          agentId: replacing.agentId ?? "custom seat",
                          detail: `${error.detail} ${error.nextStep}`,
                        })
                      : new CrewLaunchOperationError({
                          phase: "reading the crew's playbook run",
                          seatName: replacing.seat,
                          createdSeats: [],
                          cause: error.cause,
                        }),
                  ),
                ),
            };
      return yield* launcher.addSeats({
        providerSessionId: PROPOSAL_SESSION,
        requestKey: proposal.id,
        captain,
        instance,
        seats: launchSeats,
        resolvedSeats,
        pick,
        brief: proposal.brief,
        playbook,
        onReserved: () => recordApproval(proposal, seats),
        replacement,
      });
    });

    const propose: CrewProposalServiceShape["propose"] = (input) => {
      const proposalId = lifecycleId({
        kind: "crew",
        operation: "proposal",
        providerSessionId: PROPOSAL_SESSION,
        requestKey: input.requestKey,
      });
      return gates.withLock(
        proposalId,
        Effect.gen(function* () {
          const request = {
            id: proposalId,
            projectId: input.captain.projectId,
            captainParticipantId: input.captain.participantId,
            captainThreadId: input.captain.thread.id,
            crewInstanceId: null,
            kind: "roster",
            brief: input.brief,
            displayName: input.displayName,
            requestedSeats: input.seats,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            playbook:
              input.playbook === undefined
                ? null
                : { name: input.playbook.name.replace(/\.yaml$/, "") },
          } satisfies ProposalRequest;
          const original = yield* proposals
            .read(proposalId)
            .pipe(Effect.mapError(operationError("reading the proposal")));
          // The optional playbook summary describes fresh validation; replay never reads a changed definition.
          if (original !== null) return yield* replayProposal(original, request);
          const serverSettings = yield* settings.getSettings.pipe(
            Effect.mapError(operationError("reading Crew approval settings")),
          );
          const automatic = resolveProjectSettings(serverSettings, input.captain.thread.projectId)
            .settings.crewAutoApprove;
          const playbookRef =
            input.playbook === undefined
              ? null
              : yield* playbooks
                  .definitionPathFor(input.playbook.workspaceRoot, input.playbook.name)
                  .pipe(
                    Effect.map(({ stem, definitionPath }) => ({ name: stem, definitionPath })),
                    Effect.mapError(playbookRefusal(input.playbook.name, "propose")),
                  );
          const definition =
            playbookRef === null ? null : yield* readPlaybook(playbookRef, "propose");
          const plan = yield* validateSeats(
            input.seats,
            null,
            false,
            definition === null ? null : { definition, existingMembers: [] },
          );
          const seats = withPersonaSwaps(
            yield* pinSeats(input.captain, input.seats),
            plan.swapsBySeat,
          );
          if (automatic) yield* resolveRuntime(input.captain, seats, "agent");
          const proposal = yield* proposals
            .create({
              ...request,
              approvalMode: automatic ? "automatic" : "human",
              playbook: playbookRef,
              requestedSeats: seats,
            })
            .pipe(Effect.mapError(operationError("recording the proposal")));
          // The stored row decides what happened: an open automatic proposal is approved here.
          return {
            ...(yield* replayProposal(proposal, request)),
            playbook: playbookOutcome(plan),
          };
        }),
      );
    };

    /** Why these seats can't replace the seats they name, as the Captain is told; null when they can. */
    const replacementRefusal = (
      instance: AgentCrewInstance,
      seats: ReadonlyArray<CrewProposalSeat>,
      captainTitle: string | null,
    ) => {
      const replacing = seats.filter((seat) => seat.replaces !== undefined);
      if (replacing.length === 0) return null;
      const seatList = instance.members.map(({ seatName }) => seatName).join(", ") || "none";
      if (seats.length > 1)
        return new CrewProposalRequestError({
          detail: "A replacement is one seat at a time.",
          nextStep: "Request the replacement on its own.",
        });
      const seat = replacing[0]!;
      const replaces = seat.replaces!;
      const own = ["captain", captainTitle?.toLowerCase()].includes(replaces.toLowerCase());
      if (own && !instance.members.some(({ seatName }) => seatName === replaces))
        return new CrewProposalRequestError({
          detail: `${replaces} is you, this crew's Captain, not one of its seats; a Captain can't replace itself.`,
          nextStep: `Name the member seat to replace: ${seatList}.`,
        });
      const problem = replacementProblem(instance, replaces, seat.seat);
      return problem === null
        ? null
        : new CrewProposalRequestError({
            detail: problem,
            nextStep: `Name a live member's seat to replace: ${seatList}.`,
          });
    };

    /**
     * The replaced seat's steps that move: the Crew run's current step and every later one in
     * the live order. Without an active run, every step it owns moves; a run whose definition
     * can't be read can't say which steps are done, so the replacement is refused.
     */
    const unfinishedSteps = Effect.fn("j5.a2a.crewProposal.unfinishedSteps")(function* (
      instance: AgentCrewInstance,
      seatName: string,
    ) {
      const owned =
        instance.members.find((member) => member.seatName === seatName)?.playbookStepIds ?? [];
      if (owned.length === 0) return [];
      const run = yield* playbooks
        .activeRunForCrew(instance.id)
        .pipe(Effect.mapError(operationError("reading the crew's playbook run")));
      if (run === null) return owned;
      const order = run.steps.map(({ id }) => id);
      const current = order.indexOf(run.currentStepId);
      if (current < 0)
        return yield* new CrewProposalRequestError({
          detail: `The crew's playbook run is at step ${run.currentStepId}, which its definition can't show${run.issue ? ` (${run.issue.message})` : ""}, so the steps seat ${seatName} finished can't be told apart.`,
          nextStep: "Fix the playbook or reselect a step, then request the replacement again.",
        });
      const later = order.slice(current);
      return owned.filter((stepId) => later.includes(stepId));
    });

    const relay = yield* makePlaybookCrewRelay;

    /**
     * After the swap: the replaced member's running turn is interrupted, with no message to it,
     * and a current step it had been handed goes to its replacement. Both are keyed by the
     * request, so a retry of the same call finishes whichever did not happen.
     */
    const finishReplacement = Effect.fn("j5.a2a.crewProposal.finishReplacement")(function* (
      outcome: CrewProposalOutcome,
      proposalId: string,
      seat: CrewProposalSeat,
    ) {
      if (seat.replaces === undefined || outcome.instance === null) return;
      const replacedBy = participantIdForThread(crewSeatThreadId(proposalId, seat.seat));
      const replaced = (outcome.instance.replaced ?? []).find(
        (member) =>
          member.seatName === seat.replaces && member.replacedByParticipantId === replacedBy,
      );
      if (replaced === undefined) return;
      const thread = yield* getThreadRecordsIfPresent(threadManagement, replaced.threadId, []).pipe(
        Effect.mapError(operationError("reading the replaced member")),
      );
      if (thread !== null && thread.thread.archivedAt === null && thread.thread.deletedAt == null)
        yield* stopThread(threadManagement, {
          commandId: lifecycleCommandId({
            providerSessionId: PROPOSAL_SESSION,
            requestKey: proposalId,
            operation: "replaced-seat-stop",
          }),
          threadId: replaced.threadId,
          reason: AGENT_STOP_REASON,
        }).pipe(Effect.mapError(operationError("stopping the replaced member")));
      yield* relay
        .handOver({
          crewInstanceId: outcome.instance.id,
          fromThreadId: replaced.threadId,
          requestKey: `replace:${proposalId}`,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new CrewProposalRequestError({
                detail: `Seat ${seat.replaces} was replaced by ${seat.seat}, but the step it held wasn't handed over: ${error.message}`,
                nextStep: "Retry this call with the same client_request_id.",
              }),
          ),
        );
    });

    const requestMember: CrewProposalServiceShape["requestMember"] = (input) => {
      const proposalId = lifecycleId({
        kind: "crew",
        operation: "proposal",
        providerSessionId: PROPOSAL_SESSION,
        requestKey: input.requestKey,
      });
      return gates.withLock(
        proposalId,
        Effect.gen(function* () {
          const commanded = yield* crews
            .listForCaptain({
              projectId: input.captain.projectId,
              captainParticipantId: input.captain.participantId,
            })
            .pipe(
              Effect.map((instances) =>
                instances.filter((instance) => instance.archivedAt === null),
              ),
              Effect.mapError(operationError("reading commanded crews")),
            );
          const instance =
            input.crewInstanceId === null
              ? commanded.length === 1
                ? commanded[0]!
                : null
              : (commanded.find(({ id }) => id === input.crewInstanceId) ?? null);
          if (instance === null)
            return yield* new CrewProposalRequestError({
              detail:
                commanded.length === 0
                  ? "You command no live crew, so there is nothing to add a member to."
                  : input.crewInstanceId === null
                    ? `You command ${commanded.length} crews; say which one.`
                    : `You do not command crew ${input.crewInstanceId}.`,
              nextStep:
                commanded.length === 0
                  ? "Propose a crew with j5_propose_crew first."
                  : `Retry with crew_instance_id set to one of: ${commanded.map(({ id }) => id).join(", ")}.`,
            });
          const request = {
            id: proposalId,
            projectId: input.captain.projectId,
            captainParticipantId: input.captain.participantId,
            captainThreadId: input.captain.thread.id,
            crewInstanceId: instance.id,
            kind: "addition",
            brief: input.brief ?? instance.brief,
            displayName: instance.displayName,
            requestedSeats: [input.seat],
            createdAt: DateTime.formatIso(yield* DateTime.now),
            playbook: instance.playbook ?? null,
          } satisfies CreateCrewProposalInput;
          // Replays precede mutable catalog, playbook, seat-name and capacity validation.
          const existing = yield* proposals
            .read(proposalId)
            .pipe(Effect.mapError(operationError("reading the proposal")));
          if (existing !== null)
            return yield* replayProposal(existing, request).pipe(
              Effect.tap((outcome) => finishReplacement(outcome, proposalId, input.seat)),
            );
          const refusal = replacementRefusal(instance, [input.seat], input.captain.thread.title);
          if (refusal !== null) return yield* refusal;
          const live = withoutReplaced(instance, [input.seat]);
          const definition = yield* readFollowed(instance.playbook, [input.seat], "crew");
          const plan = yield* validateSeats(
            [input.seat],
            live.members.map(({ seatName }) => seatName),
            false,
            definition === null ? null : { definition, existingMembers: memberSteps(live) },
            formerSeatNames(instance, [input.seat]),
          );
          const seats = withPersonaSwaps(
            yield* pinSeats(input.captain, [input.seat]),
            plan.swapsBySeat,
          );
          yield* resolveRuntime(input.captain, seats, "agent", instance);
          const admitted = yield* proposals
            .admit(
              {
                ...request,
                approvalMode: "automatic",
                requestedSeats: seats,
              },
              // A replacement never grows the Crew, so it isn't held to the cap.
              {
                maxSeats:
                  replacedSeatNames(seats).length > 0 ? Number.MAX_SAFE_INTEGER : CREW_SEAT_CAP,
              },
            )
            .pipe(Effect.mapError(operationError("recording the proposal")));
          if (admitted.status === "cap-exceeded")
            return yield* crewFullError(
              instance.displayName,
              admitted.held,
              admitted.adding,
              "request",
            );
          const outcome = yield* replayProposal(admitted.proposal, request);
          yield* finishReplacement(outcome, proposalId, input.seat);
          return { ...outcome, playbook: playbookOutcome(plan) };
        }),
      );
    };

    /**
     * A roster approval that recorded its Crew and then failed before it resolved (its link or
     * its resolution write) spawned nothing. Declining that proposal retires the empty record so
     * no Crew is left live beneath a declined card.
     */
    const retireUnlaunchedCrew = Effect.fn("j5.a2a.crewProposal.retireUnlaunchedCrew")(function* (
      proposal: CrewProposal,
    ) {
      if (proposal.kind !== "roster" || proposal.crewInstanceId === null) return;
      const instance = yield* crews
        .read(proposal.crewInstanceId)
        .pipe(Effect.mapError(operationError("reading the crew")));
      if (instance === null || instance.archivedAt !== null) return;
      yield* crews
        .markArchived(instance.id, DateTime.formatIso(yield* DateTime.now))
        .pipe(Effect.mapError(operationError("retiring the unlaunched crew")));
    });

    /** Seats on a card the person approves are their pick; seats approved automatically are the Captain's. */
    const resolveRuntime = (
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewProposalSeat>,
      pick: CrewSeatPick,
      crew: AgentCrewInstance | null = null,
    ) => launcher.resolveSeats(captain, seats.map(launchSeatOf), pick, crew);

    /** Saves each new worktree's commit on its seat before a proposal is stored; refuses a base that has none. */
    const pinSeats = (captain: CrewCaptain, seats: ReadonlyArray<CrewProposalSeat>) =>
      launcher.pinWorkspaces(captain, seats.map(launchSeatOf)).pipe(
        Effect.map((workspaces) => withBaseCommits(seats, workspaces)),
        Effect.mapError(
          ({ detail, nextStep }) => new CrewProposalRequestError({ detail, nextStep }),
        ),
      );

    /** Preview and approval consult the same live roster and the same live playbook. */
    const validateProposalSeats = Effect.fn("j5.a2a.crewProposal.validateProposalSeats")(function* (
      proposal: CrewProposal,
      seats: ReadonlyArray<CrewProposalSeat>,
    ) {
      // The human may have renamed or added seats on the card; check them against the live
      // roster, or an approved duplicate would spawn a seat the snapshot cannot record.
      const existingCrew =
        proposal.crewInstanceId === null || proposal.kind === "roster"
          ? null
          : yield* crews
              .read(proposal.crewInstanceId)
              .pipe(Effect.mapError(operationError("reading the crew")));
      // A request left open past j5_archive_crew must not seat agents into a retired Crew.
      if (existingCrew !== null && existingCrew.archivedAt !== null)
        return yield* new CrewProposalRequestError({
          detail: `Proposal ${proposal.id} adds to crew ${existingCrew.id}, which has been retired.`,
          nextStep: "Decline this proposal.",
        });
      if (existingCrew !== null) {
        const problem = replacementRefusal(existingCrew, seats, null);
        if (problem !== null) return yield* problem;
      }
      const liveCrew = existingCrew === null ? null : withoutReplaced(existingCrew, seats);
      const otherSeats =
        proposal.kind === "roster"
          ? null
          : (liveCrew?.members ?? []).map(({ seatName }) => seatName);
      // Read again at every preview and approval: a step removed or a file broken since the
      // Captain proposed refuses a seat claiming steps here, and the card shows why.
      const definition = yield* readFollowed(proposal.playbook, seats, "approval");
      const plan = yield* validateSeats(
        seats,
        otherSeats,
        true,
        definition === null ? null : { definition, existingMembers: memberSteps(liveCrew) },
        existingCrew === null ? [] : formerSeatNames(existingCrew, seats),
      );
      // The request was counted against open requests when it was filed; the approval only has
      // to fit the live rows, which the member store enforces again when it reserves them.
      if (otherSeats !== null && otherSeats.length + seats.length > CREW_SEAT_CAP)
        return yield* crewFullError(
          proposal.displayName,
          otherSeats.length,
          seats.length,
          "approval",
        );
      return { plan, definition, existingCrew };
    });

    const preview: CrewProposalServiceShape["preview"] = Effect.fn("j5.a2a.crewProposal.preview")(
      function* (input) {
        const proposal = yield* proposals
          .read(input.proposalId)
          .pipe(Effect.mapError(operationError("reading the proposal")));
        if (proposal === null)
          return yield* new CrewProposalNotFoundError({ proposalId: input.proposalId });
        if (proposal.status !== "open")
          return yield* new CrewProposalNotOpenError({
            proposalId: proposal.id,
            status: proposal.status,
          });
        const seats = input.seats ?? proposal.requestedSeats;
        const { plan, existingCrew } = yield* validateProposalSeats(proposal, seats);
        const captain = yield* captainFor(proposal);
        // Only a card the person is about to approve is previewed.
        const resolved = yield* resolveRuntime(captain, seats, "person", existingCrew);
        return {
          proposalId: proposal.id,
          workspaceOptions: yield* launcher.workspaceOptions(captain),
          approvalToken: crewApprovalToken(
            proposal,
            captain,
            resolved,
            planDigest(proposal.playbook, plan),
          ),
          seats: resolved.map((entry) => {
            const swaps = plan.swapsBySeat.get(entry.runtime.seat);
            return swaps === undefined ? entry.runtime : { ...entry.runtime, personaSwaps: swaps };
          }),
          ...(plan.summary === null
            ? {}
            : { playbook: plan.summary, unownedSteps: plan.unownedSteps }),
        };
      },
    );

    const resolveProposal = Effect.fn("j5.a2a.crewProposal.resolveProposal")(function* (
      input: ResolveCrewProposalInput,
      automatic = false,
    ): Effect.fn.Return<CrewProposalOutcome, CrewProposalError> {
      // Who is answering rides on the proposal from here: both notices and the record read it.
      const proposal = yield* proposals.read(input.proposalId).pipe(
        Effect.mapError(operationError("reading the proposal")),
        Effect.map((read) =>
          read === null ? null : { ...read, decidedBy: input.decidedBy ?? null },
        ),
      );
      if (proposal === null)
        return yield* new CrewProposalNotFoundError({ proposalId: input.proposalId });
      if (proposal.status !== "open")
        return yield* new CrewProposalNotOpenError({
          proposalId: proposal.id,
          status: proposal.status,
        });
      if (input.decision === "decline") {
        // Told before it is recorded: a notice or cleanup the store refused leaves the
        // proposal open for the person to decline again, and the notice id is deterministic.
        yield* retireUnlaunchedCrew(proposal);
        yield* notifyDeclined(proposal);
        const declined = yield* proposals
          .resolve({
            id: proposal.id,
            decision: "decline",
            approvedSeats: null,
            resolvedAt: DateTime.formatIso(yield* DateTime.now),
            decidedBy: proposal.decidedBy,
          })
          .pipe(Effect.mapError(operationError("recording the decline")));
        if (declined === null)
          return yield* new CrewProposalNotOpenError({
            proposalId: proposal.id,
            status: "resolved",
          });
        yield* recordResolved(proposal, null);
        return { proposal: declined, instance: null } satisfies CrewProposalOutcome;
      }
      const seats = input.seats ?? proposal.requestedSeats;
      const { plan, definition, existingCrew } = yield* validateProposalSeats(proposal, seats);
      const captain = yield* captainFor(proposal);
      const pick = automatic ? "agent" : "person";
      const resolved = yield* resolveRuntime(captain, seats, pick, existingCrew);
      if (
        !automatic &&
        input.approvalToken !==
          crewApprovalToken(proposal, captain, resolved, planDigest(proposal.playbook, plan))
      )
        return yield* new CrewProposalRequestError({
          detail:
            "The crew runtime preview is missing or has changed since it was shown: the roster, a seat's runtime, the playbook plan, a seat's workspace, or the Captain's branch or worktree may have changed.",
          nextStep: "Refresh the preview and review the current settings before approving.",
        });
      const launched = yield* fulfil(
        proposal,
        captain,
        withPersonaSwaps(
          withBaseCommits(
            seats,
            resolved.map(({ workspace }) => workspace),
          ),
          plan.swapsBySeat,
        ),
        resolved,
        launchPlaybook(proposal.playbook, definition),
        pick,
      ).pipe(
        // The member store is authoritative when concurrent additions claim the same step.
        Effect.catchTags({
          CrewStepAlreadyOwnedError: (error) =>
            Effect.fail(
              new CrewProposalRequestError({
                detail: `Step ${error.stepId} is already owned by seat ${error.ownerSeat}.`,
                nextStep: "Ask the Captain to request the seat again with only unowned steps.",
              }),
            ),
        }),
      );
      const final = yield* proposals
        .read(proposal.id)
        .pipe(Effect.mapError(operationError("reading the approved proposal")));
      // The Captain hears once the seats have started or failed to start, not now: a
      // dispatched brief is intent, and the report says what became of it.
      yield* reporter.watch(proposal.id, launched.seats);
      yield* recordResolved(proposal, seats);
      return {
        proposal: final ?? proposal,
        instance: launched.instance,
      } satisfies CrewProposalOutcome;
    });

    const refusedAutomaticRequest = (proposal: CrewProposal, detail: string) =>
      new CrewProposalRequestError({
        detail: `Automatic request for ${proposal.requestedSeats.map(({ seat }) => seat).join(", ")} was refused: ${detail}`,
        nextStep:
          "Fix the reported problem, then submit a revised request with a new client_request_id.",
      });

    const approveAutomatically = (proposalId: string) => {
      const refused = Effect.fn("j5.a2a.crewProposal.refused")(function* (
        error: CrewProposalError,
      ): Effect.fn.Return<never, CrewProposalError> {
        const proposal = yield* proposals
          .read(proposalId)
          .pipe(Effect.mapError(operationError("reading the refused request")));
        const detail = error._tag === "CrewProposalRequestError" ? error.detail : error.message;
        if (proposal?.status === "open") {
          yield* retireUnlaunchedCrew(proposal);
          yield* proposals
            .resolve({
              id: proposalId,
              decision: "decline",
              refusalDetail: detail,
              approvedSeats: null,
              resolvedAt: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(Effect.mapError(operationError("recording the refusal")));
          yield* recordResolved(proposal, null);
        }
        if (proposal === null) return yield* error;
        return yield* refusedAutomaticRequest(proposal, detail);
      });
      return resolveProposal({ proposalId, decision: "approve" }, true).pipe(
        Effect.catchTags({
          CrewProposalRequestError: refused,
          CrewLaunchSeatUnavailableError: refused,
          CrewLaunchModelNotEligibleError: refused,
          CrewLaunchCapError: refused,
          CrewLaunchSeatConflictError: refused,
          CrewStepAlreadyOwnedError: refused,
        }),
      );
    };

    const replayProposal = Effect.fn("j5.a2a.crewProposal.replay")(function* (
      original: CrewProposal,
      request: ProposalRequest,
    ) {
      if (requestDigest(proposalRequest(original)) !== requestDigest(proposalRequest(request)))
        return yield* new CrewProposalRequestError(
          requestReplayConflict(
            `proposal ${original.id}${original.crewInstanceId === null ? "" : ` and crew ${original.crewInstanceId}`}`,
          ),
        );
      if (original.status === "declined" && original.approvalMode === "automatic")
        return yield* refusedAutomaticRequest(
          original,
          original.refusalDetail ?? "The original refusal detail is unavailable.",
        );
      if (original.status === "open" && original.approvalMode === "automatic")
        return yield* approveAutomatically(original.id);
      const instance =
        original.crewInstanceId === null
          ? null
          : yield* crews
              .read(original.crewInstanceId)
              .pipe(Effect.mapError(operationError("reading the crew")));
      return { proposal: original, instance };
    });

    const resolve: CrewProposalServiceShape["resolve"] = (input) =>
      gates.withLock(input.proposalId, resolveProposal(input));
    return CrewProposalService.of({ propose, requestMember, preview, resolve });
  }),
);

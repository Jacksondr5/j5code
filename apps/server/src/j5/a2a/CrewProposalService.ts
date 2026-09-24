import type {
  CrewProposalPreviewRequest,
  CrewProposalPreviewResponse,
} from "@t3tools/contracts/j5";
import { crewApprovalToken } from "./crewRuntimePreview.ts";
import { MessageId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  type CrewProposal,
  type CrewProposalDecision,
  type CrewProposalSeat,
} from "./AgentCrewProposalService.ts";
import {
  CREW_SEAT_CAP,
  CrewLaunchOperationError,
  CrewLaunchService,
  type CrewCaptain,
  type CrewLaunchError,
  type ResolvedCrewLaunchSeat,
} from "./CrewLaunchService.ts";
import { crewDeclinedNoticeText } from "./crewGateNotice.ts";
import { CrewLaunchReporter } from "./CrewLaunchReporter.ts";
import { crewSeatShapeProblem } from "./crewLimits.ts";
import { CREW_PROPOSAL_SESSION, crewSeatReservedBy } from "./crewSeatIds.ts";
import { A2ALedger } from "./LedgerService.ts";
import { crewSeatRequestKey, lifecycleCommandId, lifecycleId } from "./spawnIds.ts";
import { getThreadProjectionIfPresent } from "./threadProjectionReads.ts";

/** Hard cap on seats per Crew, initial roster and additions together. */
export { CREW_SEAT_CAP } from "./CrewLaunchService.ts";

const PROPOSAL_SESSION = CREW_PROPOSAL_SESSION;

export class CrewProposalRequestError extends Data.TaggedError("CrewProposalRequestError")<{
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

export class CrewProposalNotFoundError extends Data.TaggedError("CrewProposalNotFoundError")<{
  readonly proposalId: string;
}> {
  override get message(): string {
    return `Proposal ${this.proposalId} does not exist in this environment.`;
  }
}

export class CrewProposalOperationError extends Data.TaggedError("CrewProposalOperationError")<{
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
}

export interface CrewProposalOutcome {
  readonly proposal: CrewProposal;
  readonly instance: AgentCrewInstance | null;
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
  readonly resolve: (
    input: ResolveCrewProposalInput,
  ) => Effect.Effect<CrewProposalOutcome, CrewProposalError>;
  /**
   * The boot sweep for resolutions the server lost mid-way: a claimed decline is finished (its
   * cleanup done and the decline recorded) and a claimed approval is handed back to the gate,
   * since its launch converges on a retry. Returns the proposal ids it settled.
   */
  readonly reconcile: Effect.Effect<ReadonlyArray<string>>;
}

export class CrewProposalService extends Context.Service<
  CrewProposalService,
  CrewProposalServiceShape
>()("t3/j5/a2a/CrewProposalService") {}

const seatNamesUnique = (seats: ReadonlyArray<CrewProposalSeat>) =>
  new Set(seats.map(({ seat }) => seat)).size === seats.length;

export const layer = Layer.effect(
  CrewProposalService,
  Effect.gen(function* () {
    const proposals = yield* AgentCrewProposalService;
    const crews = yield* AgentCrewInstanceService;
    const launcher = yield* CrewLaunchService;
    const reporter = yield* CrewLaunchReporter;
    const threadManagement = yield* ThreadManagementService;
    const ledger = yield* A2ALedger;
    const agents = yield* makeAgentPersonaLibrary;

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
     * Persona seats must name known, enabled personas; the library is the source of truth, not the
     * Captain. A custom seat names none and is checked for shape only.
     */
    const validateSeats = Effect.fn("j5.a2a.crewProposal.validateSeats")(function* (
      seats: ReadonlyArray<CrewProposalSeat>,
      /** The live Crew's seat names for an addition; null for a new roster. */
      existingSeatNames: ReadonlyArray<string> | null,
      humanReview = false,
    ) {
      if (seats.length === 0)
        return yield* new CrewProposalRequestError({
          detail: "A crew request needs at least one seat.",
          nextStep: "Call list_personas, then propose seats with a reason each.",
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
      const disabled = new Set(catalog.disabledIds);
      for (const seat of seats) {
        if (seat.agentId === null) continue;
        const definition = catalog.definitions.find(({ id }) => id === seat.agentId);
        if (definition === undefined)
          return yield* new CrewProposalRequestError({
            detail: `Seat ${seat.seat} names persona "${seat.agentId}", which is not in this environment's library.`,
            nextStep: "Call list_personas and pick a persona id it returns.",
          });
        if (disabled.has(seat.agentId))
          return yield* new CrewProposalRequestError({
            detail: `Seat ${seat.seat} names persona "${seat.agentId}", which is turned off.`,
            nextStep: "Pick an enabled persona from list_personas, or ask the user to turn it on.",
          });
      }
    });

    /** The decline is told at once; an approval is told by the launch report, once the seats are up. */
    const notifyDeclined = Effect.fn("j5.a2a.crewProposal.notifyDeclined")(function* (
      proposal: CrewProposal,
    ) {
      const stable = { providerSessionId: PROPOSAL_SESSION, requestKey: proposal.id };
      const captain = yield* getThreadProjectionIfPresent(
        threadManagement,
        proposal.captainThreadId,
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
      const projection = yield* getThreadProjectionIfPresent(
        threadManagement,
        proposal.captainThreadId,
      ).pipe(Effect.mapError(operationError("reading the Captain thread")));
      // Checked when the person approves, not held: a Captain archived or deleted while its gate
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
      const squadron = yield* ledger
        .readSquadron(proposal.squadronId)
        .pipe(Effect.mapError(operationError("reading the Squadron")));
      return {
        squadronId: proposal.squadronId,
        squadronName: squadron.name,
        participantId: proposal.captainParticipantId,
        thread: projection.thread,
      } satisfies CrewCaptain;
    });

    /** Spawn the approved seats for a resolved proposal; the proposal id keys every spawn. */
    const fulfil = Effect.fn("j5.a2a.crewProposal.fulfil")(function* (
      proposal: CrewProposal,
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewProposalSeat>,
      resolvedSeats: ReadonlyArray<ResolvedCrewLaunchSeat>,
    ) {
      const launchSeats = seats.map((seat) => ({
        name: seat.seat,
        agentId: seat.agentId,
        reason: seat.reason,
        instructions: seat.instructions,
        modelSelection: seat.modelSelection,
        runtimeMode: seat.runtimeMode,
      }));
      if (proposal.kind === "roster") {
        return yield* launcher.launch({
          providerSessionId: PROPOSAL_SESSION,
          requestKey: proposal.id,
          captain,
          displayName: proposal.displayName,
          seats: launchSeats,
          resolvedSeats,
          brief: proposal.brief,
          // The proposal must name its Crew: declining a reopened proposal retires the Crew
          // through this link, so a lost write fails the approval before any seat spawns.
          onRecorded: (instance) =>
            proposals.attachInstance(proposal.id, instance.id).pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) =>
                  new CrewLaunchOperationError({
                    phase: `linking proposal ${proposal.id} to crew ${instance.id}`,
                    seatName: null,
                    createdSeats: [],
                    cause,
                  }),
              ),
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
      return yield* launcher.addSeats({
        providerSessionId: PROPOSAL_SESSION,
        requestKey: proposal.id,
        captain,
        instance,
        seats: launchSeats,
        resolvedSeats,
        brief: proposal.brief,
      });
    });

    /**
     * Human approval is the authority (Bryant, 2026-09-10): the person who approves the roster
     * decides who gets what access, so approved seats run with their own agent's permissions
     * even when the Captain is read-only. There is no other way through this gate.
     */
    /**
     * Claims the gate for this decision, compare-and-set from open. The claim is what a second
     * device runs into: it finds the row approving or declining and is refused, so a decline can
     * never retire the Crew an approval is launching, whichever order the two arrive in.
     */
    const claim = Effect.fn("j5.a2a.crewProposal.claim")(function* (
      proposal: CrewProposal,
      decision: CrewProposalDecision,
      approvedSeats: ReadonlyArray<CrewProposalSeat> | null,
    ) {
      const claimed = yield* proposals
        .claim({ id: proposal.id, decision, approvedSeats })
        .pipe(Effect.mapError(operationError("claiming the proposal")));
      if (claimed !== null) return claimed;
      const current = yield* proposals
        .read(proposal.id)
        .pipe(Effect.mapError(operationError("reading the proposal")));
      return yield* new CrewProposalNotOpenError({
        proposalId: proposal.id,
        status: current?.status ?? "open",
      });
    });

    const complete = Effect.fn("j5.a2a.crewProposal.complete")(function* (
      proposal: CrewProposal,
      decision: CrewProposalDecision,
      crewInstanceId: string | null,
    ) {
      const final = yield* proposals
        .complete({
          id: proposal.id,
          decision,
          crewInstanceId,
          resolvedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.mapError(operationError("recording the resolution")));
      if (final === null)
        return yield* new CrewProposalOperationError({
          phase: "recording the resolution",
          cause: new Error(`Proposal ${proposal.id} was no longer claimed for this decision.`),
        });
      return final;
    });

    const settle = Effect.fn("j5.a2a.crewProposal.settle")(function* (
      claimed: CrewProposal,
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewProposalSeat>,
      resolvedSeats: ReadonlyArray<ResolvedCrewLaunchSeat>,
    ) {
      const instance = yield* fulfil(claimed, captain, seats, resolvedSeats).pipe(
        // A failed spawn hands the gate back to the human rather than recording a phantom crew;
        // onError also fires on a defect, so an unexpected failure cannot leave it claimed.
        Effect.onError(() => proposals.reopen(claimed.id).pipe(Effect.ignore)),
      );
      const final = yield* complete(claimed, "approve", instance.id);
      // The Captain hears once the seats have started or failed to start, not now: a dispatched
      // brief is intent, and the report says what became of it.
      yield* reporter.watch(final.id);
      return { proposal: final, instance } satisfies CrewProposalOutcome;
    });

    const propose: CrewProposalServiceShape["propose"] = (input) =>
      Effect.gen(function* () {
        yield* validateSeats(input.seats, null);
        const proposal = yield* proposals
          .create({
            id: lifecycleId({
              kind: "crew",
              operation: "proposal",
              providerSessionId: PROPOSAL_SESSION,
              requestKey: input.requestKey,
            }),
            squadronId: input.captain.squadronId,
            captainParticipantId: input.captain.participantId,
            captainThreadId: input.captain.thread.id,
            crewInstanceId: null,
            kind: "roster",
            brief: input.brief,
            displayName: input.displayName,
            requestedSeats: input.seats,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.mapError(operationError("recording the proposal")));
        if (proposal.status !== "open") {
          const instance =
            proposal.crewInstanceId === null
              ? null
              : yield* crews.read(proposal.crewInstanceId).pipe(Effect.orDie);
          return { proposal, instance };
        }
        return { proposal, instance: null };
      });

    const requestMember: CrewProposalServiceShape["requestMember"] = (input) =>
      Effect.gen(function* () {
        const commanded = yield* crews
          .listForCaptain({
            squadronId: input.captain.squadronId,
            captainParticipantId: input.captain.participantId,
          })
          .pipe(
            Effect.map((instances) => instances.filter((instance) => instance.archivedAt === null)),
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
                ? "Propose a crew with propose_crew first."
                : `Retry with crew_instance_id set to one of: ${commanded.map(({ id }) => id).join(", ")}.`,
          });
        const proposalId = lifecycleId({
          kind: "crew",
          operation: "proposal",
          providerSessionId: PROPOSAL_SESSION,
          requestKey: input.requestKey,
        });
        // A replayed request finds its proposal before anything is checked or counted: once its
        // seat has launched, the name clash and the cap would both refuse the retry otherwise.
        const replayed = yield* proposals
          .read(proposalId)
          .pipe(Effect.mapError(operationError("reading the proposal")));
        if (replayed !== null) {
          const current = yield* crews.read(instance.id).pipe(Effect.orDie);
          return { proposal: replayed, instance: current };
        }
        yield* validateSeats(
          [input.seat],
          instance.members.map(({ seatName }) => seatName),
        );
        const admitted = yield* proposals
          .admit(
            {
              id: proposalId,
              squadronId: input.captain.squadronId,
              captainParticipantId: input.captain.participantId,
              captainThreadId: input.captain.thread.id,
              crewInstanceId: instance.id,
              kind: "addition",
              brief: input.brief ?? instance.brief,
              displayName: instance.displayName,
              requestedSeats: [input.seat],
              createdAt: DateTime.formatIso(yield* DateTime.now),
            },
            { maxSeats: CREW_SEAT_CAP },
          )
          .pipe(Effect.mapError(operationError("recording the proposal")));
        if (admitted.status === "cap-exceeded")
          return yield* crewFullError(
            instance.displayName,
            admitted.held,
            admitted.adding,
            "request",
          );
        if (admitted.proposal.status !== "open") {
          const current = yield* crews.read(instance.id).pipe(Effect.orDie);
          return { proposal: admitted.proposal, instance: current };
        }
        return { proposal: admitted.proposal, instance };
      });

    const reservedByProposal = crewSeatReservedBy;

    /** Archive every seat thread that exists behind these members; names with no thread pass. */
    const archiveSeatThreads = Effect.fn("j5.a2a.crewProposal.archiveSeatThreads")(function* (
      proposal: CrewProposal,
      members: ReadonlyArray<{ readonly seatName: string; readonly threadId: ThreadId }>,
    ) {
      for (const member of members) {
        const seat = yield* getThreadProjectionIfPresent(threadManagement, member.threadId).pipe(
          Effect.mapError(operationError(`reading seat ${member.seatName}`)),
        );
        if (seat === null || seat.thread.archivedAt !== null) continue;
        yield* threadManagement
          .dispatch({
            type: "thread.archive",
            commandId: lifecycleCommandId({
              providerSessionId: PROPOSAL_SESSION,
              requestKey: crewSeatRequestKey(proposal.id, member.seatName),
              operation: "decline-archive",
            }),
            threadId: member.threadId,
          })
          .pipe(Effect.mapError(operationError(`archiving seat ${member.seatName}`)));
      }
    });

    /**
     * A roster launch records its Crew before any seat spawns, so a launch that failed partway
     * leaves a record naming seats that may or may not have threads. Declining that proposal
     * retires the lot: seat threads that exist are archived and the record is stamped retired.
     */
    const retireFailedLaunch = Effect.fn("j5.a2a.crewProposal.retireFailedLaunch")(function* (
      proposal: CrewProposal,
      crewInstanceId: string,
    ) {
      const instance = yield* crews
        .read(crewInstanceId)
        .pipe(Effect.mapError(operationError("reading the crew")));
      if (instance === null || instance.archivedAt !== null) return;
      yield* archiveSeatThreads(proposal, instance.members);
      yield* crews
        .markArchived(instance.id, DateTime.formatIso(yield* DateTime.now))
        .pipe(Effect.mapError(operationError("retiring the crew")));
    });

    /**
     * An addition reserves its rows in the live Crew before spawning, under names the person may
     * have changed between attempts. Declining releases every row this proposal ever minted, not
     * only the last set of names, archiving any thread a partial spawn left behind them.
     */
    const retireFailedAddition = Effect.fn("j5.a2a.crewProposal.retireFailedAddition")(function* (
      proposal: CrewProposal,
      crewInstanceId: string,
    ) {
      const instance = yield* crews
        .read(crewInstanceId)
        .pipe(Effect.mapError(operationError("reading the crew")));
      if (instance === null) return;
      const reserved = instance.members.filter(reservedByProposal(proposal.id));
      if (reserved.length === 0) return;
      yield* archiveSeatThreads(proposal, reserved);
      yield* crews
        .removeMembers(
          instance.id,
          reserved.map((member) => member.seatName),
        )
        .pipe(Effect.mapError(operationError("releasing reserved seats")));
    });

    /**
     * A claimed decline's work before it is recorded: an earlier approval may have failed partway
     * and handed the gate back, so the cleanup runs first and the Captain is told last. For an
     * addition, every row this proposal reserved is released; for a roster, the Crew record and
     * any seat threads the failed launch created are retired.
     */
    const retireAndNotifyDeclined = Effect.fn("j5.a2a.crewProposal.retireAndNotifyDeclined")(
      function* (claimed: CrewProposal) {
        if (claimed.crewInstanceId !== null) {
          if (claimed.kind === "addition")
            yield* retireFailedAddition(claimed, claimed.crewInstanceId);
          else yield* retireFailedLaunch(claimed, claimed.crewInstanceId);
        }
        yield* notifyDeclined(claimed);
      },
    );

    /** A claimed decline, cleaned up, told, and recorded; run from the gate and the boot sweep alike. */
    const finishDecline = Effect.fn("j5.a2a.crewProposal.finishDecline")(function* (
      claimed: CrewProposal,
    ) {
      yield* retireAndNotifyDeclined(claimed);
      const declined = yield* complete(claimed, "decline", null);
      return { proposal: declined, instance: null } satisfies CrewProposalOutcome;
    });

    const resolveRuntime = (captain: CrewCaptain, seats: ReadonlyArray<CrewProposalSeat>) =>
      launcher.resolveSeats(
        captain,
        seats.map((seat) => ({
          name: seat.seat,
          agentId: seat.agentId,
          reason: seat.reason,
          instructions: seat.instructions,
          modelSelection: seat.modelSelection,
          runtimeMode: seat.runtimeMode,
        })),
      );

    /** Preview and approval consult the same live roster, excluding this proposal's retry reservations. */
    const validateProposalSeats = Effect.fn("j5.a2a.crewProposal.validateProposalSeats")(function* (
      proposal: CrewProposal,
      seats: ReadonlyArray<CrewProposalSeat>,
    ) {
      // The human may have renamed or added seats on the card; check them against the live
      // roster, or an approved duplicate would spawn a seat the snapshot cannot record.
      const existingCrew =
        proposal.crewInstanceId === null
          ? null
          : yield* crews
              .read(proposal.crewInstanceId)
              .pipe(Effect.mapError(operationError("reading the crew")));
      // A request left open past archive_crew must not seat agents into a retired Crew.
      if (proposal.kind === "addition" && existingCrew !== null && existingCrew.archivedAt !== null)
        return yield* new CrewProposalRequestError({
          detail: `Proposal ${proposal.id} adds to crew ${existingCrew.id}, which has been retired.`,
          nextStep: "Decline this proposal.",
        });
      const existingMembers = existingCrew?.members ?? [];
      // An addition reserves its member rows before the seats spawn. When that spawn failed
      // and the gate was handed back, the rows are still there under this proposal's own
      // deterministic ids; they are the reservation the retry converges on, not a clash
      // (Critic Q2, 2026-09-14).
      const reservedHere = reservedByProposal(proposal.id);
      const otherSeats =
        proposal.kind === "roster"
          ? null
          : existingMembers
              .filter((member) => !reservedHere(member))
              .map(({ seatName }) => seatName);
      yield* validateSeats(seats, otherSeats, true);
      // The request was counted against open requests when it was filed; the approval only has
      // to fit the live rows, which the member store enforces again when it reserves them.
      if (otherSeats !== null && otherSeats.length + seats.length > CREW_SEAT_CAP)
        return yield* crewFullError(
          proposal.displayName,
          otherSeats.length,
          seats.length,
          "approval",
        );
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
        const seats = input.seats ?? proposal.approvedSeats ?? proposal.requestedSeats;
        yield* validateProposalSeats(proposal, seats);
        const captain = yield* captainFor(proposal);
        const resolved = yield* resolveRuntime(captain, seats);
        return {
          proposalId: proposal.id,
          approvalToken: crewApprovalToken(proposal, captain, resolved),
          seats: resolved.map((entry) => entry.runtime),
        };
      },
    );

    const resolve: CrewProposalServiceShape["resolve"] = (input) =>
      Effect.gen(function* () {
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
        if (input.decision === "decline") {
          const claimed = yield* claim(proposal, "decline", null);
          // A cleanup or notice the store refused hands the gate back so the person can decline
          // again, rather than leaving a claimed row only the next boot would finish.
          yield* retireAndNotifyDeclined(claimed).pipe(
            Effect.onError(() => proposals.reopen(claimed.id).pipe(Effect.ignore)),
          );
          // Once the decline notice is durable the row stays `declining` for the boot sweep to
          // record: reopening here would let a fresh approval launch beneath a declined card.
          const declined = yield* complete(claimed, "decline", null);
          return { proposal: declined, instance: null } satisfies CrewProposalOutcome;
        }
        const seats = input.seats ?? proposal.approvedSeats ?? proposal.requestedSeats;
        yield* validateProposalSeats(proposal, seats);
        const captain = yield* captainFor(proposal);
        const resolved = yield* resolveRuntime(captain, seats);
        if (input.approvalToken !== crewApprovalToken(proposal, captain, resolved))
          return yield* new CrewProposalRequestError({
            detail: "The crew runtime preview is missing or has changed since it was shown.",
            nextStep: "Refresh the preview and review the current settings before approving.",
          });
        const claimed = yield* claim(proposal, "approve", seats);
        return yield* settle(claimed, captain, seats, resolved);
      });

    const reconcile: CrewProposalServiceShape["reconcile"] = Effect.gen(function* () {
      const claimed = yield* proposals.listClaimed();
      const settled: Array<string> = [];
      for (const proposal of claimed) {
        // One proposal's failure is logged and left for the next boot; the sweep reaches the rest.
        const done = yield* Effect.gen(function* () {
          if (proposal.status === "declining") {
            yield* finishDecline(proposal);
            yield* Effect.logInfo("J5 crew proposal sweep finished a lost decline", {
              proposalId: proposal.id,
            });
          } else {
            yield* proposals.reopen(proposal.id);
            yield* Effect.logInfo("J5 crew proposal sweep handed a lost approval back", {
              proposalId: proposal.id,
            });
          }
        }).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 crew proposal sweep could not settle a claimed proposal", {
              proposalId: proposal.id,
              status: proposal.status,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (done) settled.push(proposal.id);
      }
      return settled;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("J5 crew proposal sweep failed", { cause }).pipe(Effect.as([])),
      ),
    );
    return CrewProposalService.of({ propose, requestMember, preview, resolve, reconcile });
  }),
);

/**
 * Runs the boot sweep once, in the background, when the runtime comes up; kept apart from the
 * service so tests drive `reconcile` themselves.
 */
export const bootSweepLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gate = yield* CrewProposalService;
    yield* Effect.forkScoped(gate.reconcile);
  }),
);

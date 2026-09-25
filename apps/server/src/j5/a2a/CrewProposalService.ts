import type {
  CrewProposalPreviewRequest,
  CrewProposalPreviewResponse,
} from "@t3tools/contracts/j5";
import { crewApprovalToken } from "./crewRuntimePreview.ts";
import { MessageId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeKeyedSerialExecutor } from "../../orchestration-v2/KeyedSerialExecutor.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  type CrewProposal,
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
import { CREW_PROPOSAL_SESSION } from "./crewSeatIds.ts";
import { A2ALedger } from "./LedgerService.ts";
import { lifecycleCommandId, lifecycleId } from "./spawnIds.ts";
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
    // One resolution of a proposal at a time on this server, so an approval and a decline from
    // two devices cannot interleave; the store's compare-and-set from open decides the winner.
    const gates = yield* makeKeyedSerialExecutor<string>();

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

    /**
     * Resolves the proposal as approved, compare-and-set from open. It runs before any seat
     * spawns, so a proposal that launched can never be approved or declined again.
     */
    const recordApproval = (
      proposal: CrewProposal,
      seats: ReadonlyArray<CrewProposalSeat>,
    ): Effect.Effect<void, CrewLaunchOperationError> =>
      Effect.gen(function* () {
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
          })
          .pipe(Effect.mapError(failed));
        if (approved === null)
          return yield* failed(
            `proposal ${proposal.id} was no longer open, so nothing was launched`,
          );
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
      return yield* launcher.addSeats({
        providerSessionId: PROPOSAL_SESSION,
        requestKey: proposal.id,
        captain,
        instance,
        seats: launchSeats,
        resolvedSeats,
        brief: proposal.brief,
        onReserved: () => recordApproval(proposal, seats),
      });
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

    /** Preview and approval consult the same live roster. */
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
      // A request left open past archive_crew must not seat agents into a retired Crew.
      if (existingCrew !== null && existingCrew.archivedAt !== null)
        return yield* new CrewProposalRequestError({
          detail: `Proposal ${proposal.id} adds to crew ${existingCrew.id}, which has been retired.`,
          nextStep: "Decline this proposal.",
        });
      const otherSeats =
        proposal.kind === "roster"
          ? null
          : (existingCrew?.members ?? []).map(({ seatName }) => seatName);
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
        const seats = input.seats ?? proposal.requestedSeats;
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
      gates.withLock(
        input.proposalId,
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
              })
              .pipe(Effect.mapError(operationError("recording the decline")));
            if (declined === null)
              return yield* new CrewProposalNotOpenError({
                proposalId: proposal.id,
                status: "resolved",
              });
            return { proposal: declined, instance: null } satisfies CrewProposalOutcome;
          }
          const seats = input.seats ?? proposal.requestedSeats;
          yield* validateProposalSeats(proposal, seats);
          const captain = yield* captainFor(proposal);
          const resolved = yield* resolveRuntime(captain, seats);
          if (input.approvalToken !== crewApprovalToken(proposal, captain, resolved))
            return yield* new CrewProposalRequestError({
              detail: "The crew runtime preview is missing or has changed since it was shown.",
              nextStep: "Refresh the preview and review the current settings before approving.",
            });
          const launched = yield* fulfil(proposal, captain, seats, resolved);
          const final = yield* proposals
            .read(proposal.id)
            .pipe(Effect.mapError(operationError("reading the approved proposal")));
          // The Captain hears once the seats have started or failed to start, not now: a
          // dispatched brief is intent, and the report says what became of it.
          yield* reporter.watch(proposal.id, launched.seats);
          return {
            proposal: final ?? proposal,
            instance: launched.instance,
          } satisfies CrewProposalOutcome;
        }),
      );

    return CrewProposalService.of({ propose, requestMember, preview, resolve });
  }),
);

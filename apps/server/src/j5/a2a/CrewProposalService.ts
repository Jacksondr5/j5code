import { MessageId } from "@t3tools/contracts";
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
  type CrewProposalSeat,
} from "./AgentCrewProposalService.ts";
import {
  CREW_SEAT_CAP,
  CrewLaunchService,
  type CrewCaptain,
  type CrewLaunchError,
} from "./CrewLaunchService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger } from "./LedgerService.ts";
import { crewSeatRequestKey, lifecycleCommandId, lifecycleId, spawnThreadId } from "./spawnIds.ts";

/** Hard cap on seats per Crew, initial roster and additions together. */
export { CREW_SEAT_CAP } from "./CrewLaunchService.ts";

/** Resolution-time spawns key off the proposal id so a retried approval replays the same seats. */
const PROPOSAL_SESSION = "j5-crew-proposal";

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
  /** The human's final roster on approval; the requested seats when omitted. */
  readonly seats?: ReadonlyArray<CrewProposalSeat> | undefined;
}

export interface CrewProposalOutcome {
  readonly proposal: CrewProposal;
  readonly instance: AgentCrewInstance | null;
}

export interface CrewProposalServiceShape {
  readonly propose: (
    input: ProposeCrewInput,
  ) => Effect.Effect<CrewProposalOutcome, CrewProposalError>;
  readonly requestMember: (
    input: RequestCrewMemberInput,
  ) => Effect.Effect<CrewProposalOutcome, CrewProposalError>;
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

/** The platform-composed notice a Captain receives when its gate resolves: measured facts only. */
export const crewGateNoticeText = (input: {
  readonly proposal: CrewProposal;
  readonly instance: AgentCrewInstance | null;
  readonly status: "approved" | "declined";
}) => {
  const head = `<j5_crew_gate>\nproposal_id: ${input.proposal.id}\nkind: ${input.proposal.kind}\ndecision: ${input.status}\ncrew_name: ${input.proposal.displayName}`;
  if (input.instance === null || input.status === "declined") {
    return `${head}\nrequested_seats: ${input.proposal.requestedSeats.map(({ seat, agentId }) => `${seat}=${agentId}`).join(", ")}\n</j5_crew_gate>\n\nThe human declined this crew request. Continue with the agents you have, or revise the request and propose again with a clearer reason.`;
  }
  const roster = input.instance.members
    .map(
      (member) =>
        `- ${member.seatName}: participant_id=${member.participantId} agent=${member.agentId} thread_id=${member.threadId}${
          member.addedVersion === input.instance!.version && input.proposal.kind === "addition"
            ? " (new)"
            : ""
        }`,
    )
    .join("\n");
  return `${head}\ncrew_instance_id: ${input.instance.id}\ncrew_version: ${input.instance.version}\nroster:\n${roster}\n</j5_crew_gate>\n\nYour crew is running. Each seat has your brief and this roster; coordinate with send_message, and ask the human through the inbox for decisions you cannot make from the brief.`;
};

export const layer = Layer.effect(
  CrewProposalService,
  Effect.gen(function* () {
    const proposals = yield* AgentCrewProposalService;
    const crews = yield* AgentCrewInstanceService;
    const launcher = yield* CrewLaunchService;
    const threadManagement = yield* ThreadManagementService;
    const ledger = yield* A2ALedger;
    const agents = yield* makeAgentPersonaLibrary;

    const operationError = (phase: string) => (cause: unknown) =>
      new CrewProposalOperationError({ phase, cause });

    /** Seats must name known, enabled agents; the library is the source of truth, not the Captain. */
    const validateSeats = Effect.fn("j5.a2a.crewProposal.validateSeats")(function* (
      seats: ReadonlyArray<CrewProposalSeat>,
      existing: { readonly seatNames: ReadonlyArray<string>; readonly pendingSeats: number },
    ) {
      const existingSeatCount = existing.seatNames.length + existing.pendingSeats;
      if (seats.length === 0)
        return yield* new CrewProposalRequestError({
          detail: "A crew request needs at least one seat.",
          nextStep: "Call list_agents, then propose seats with a reason each.",
        });
      if (!seatNamesUnique(seats))
        return yield* new CrewProposalRequestError({
          detail: "Seat names must be unique within a crew.",
          nextStep: "Rename the duplicate seats and retry.",
        });
      const taken = seats.find((seat) => existing.seatNames.includes(seat.seat));
      if (taken !== undefined)
        return yield* new CrewProposalRequestError({
          detail: `The crew already has a seat named ${taken.seat}.`,
          nextStep: "Choose a different seat name.",
        });
      if (existingSeatCount + seats.length > CREW_SEAT_CAP)
        return yield* new CrewProposalRequestError({
          detail: `A crew may hold at most ${CREW_SEAT_CAP} seats; this request would reach ${existingSeatCount + seats.length}.`,
          nextStep:
            "Request fewer seats, or let a member finish and settle before asking for more.",
        });
      const catalog = yield* agents
        .catalog()
        .pipe(Effect.mapError(operationError("reading the agent library")));
      const disabled = new Set(catalog.disabledIds);
      for (const seat of seats) {
        const definition = catalog.definitions.find(({ id }) => id === seat.agentId);
        if (definition === undefined)
          return yield* new CrewProposalRequestError({
            detail: `Seat ${seat.seat} names agent "${seat.agentId}", which is not in this environment's library.`,
            nextStep: "Call list_agents and pick an agent id it returns.",
          });
        if (disabled.has(seat.agentId))
          return yield* new CrewProposalRequestError({
            detail: `Seat ${seat.seat} names agent "${seat.agentId}", which is turned off.`,
            nextStep: "Pick an enabled agent from list_agents, or ask the human to turn it on.",
          });
      }
    });

    const notifyCaptain = Effect.fn("j5.a2a.crewProposal.notifyCaptain")(function* (
      proposal: CrewProposal,
      instance: AgentCrewInstance | null,
      status: "approved" | "declined",
    ) {
      const stable = { providerSessionId: PROPOSAL_SESSION, requestKey: proposal.id };
      const captain = yield* threadManagement
        .getThreadProjection(proposal.captainThreadId)
        .pipe(Effect.mapError(operationError("reading the Captain thread")));
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
          text: crewGateNoticeText({ proposal, instance, status }),
          attachments: [],
          modelSelection: captain.thread.modelSelection,
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.mapError(operationError("notifying the Captain")));
    });

    const captainFor = Effect.fn("j5.a2a.crewProposal.captainFor")(function* (
      proposal: CrewProposal,
    ) {
      const projection = yield* threadManagement
        .getThreadProjection(proposal.captainThreadId)
        .pipe(Effect.mapError(operationError("reading the Captain thread")));
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
    ) {
      const launchSeats = seats.map((seat) => ({
        name: seat.seat,
        agentId: seat.agentId,
        reason: seat.reason,
        instructions: seat.instructions,
      }));
      if (proposal.kind === "roster") {
        return yield* launcher.launch({
          providerSessionId: PROPOSAL_SESSION,
          requestKey: proposal.id,
          captain,
          displayName: proposal.displayName,
          seats: launchSeats,
          brief: proposal.brief,
          onRecorded: (instance) =>
            proposals.attachInstance(proposal.id, instance.id).pipe(Effect.ignore),
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
        brief: proposal.brief,
      });
    });

    /**
     * Human approval is the authority (Bryant, 2026-09-10): the person who approves the roster
     * decides who gets what access, so approved seats run with their own agent's permissions
     * even when the Captain is read-only. There is no other way through this gate.
     */
    const settle = Effect.fn("j5.a2a.crewProposal.settle")(function* (
      proposal: CrewProposal,
      captain: CrewCaptain,
      seats: ReadonlyArray<CrewProposalSeat>,
    ) {
      const status = "approved" as const;
      // Claim first so a second approval finds the proposal taken instead of spawning again.
      const claimed = yield* proposals
        .resolve({
          id: proposal.id,
          status,
          approvedSeats: seats,
          crewInstanceId: proposal.crewInstanceId,
          resolvedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.mapError(operationError("recording the resolution")));
      if (claimed === null) {
        const current = yield* proposals
          .read(proposal.id)
          .pipe(Effect.mapError(operationError("reading the proposal")));
        return yield* new CrewProposalNotOpenError({
          proposalId: proposal.id,
          status: current?.status ?? "open",
        });
      }
      const instance = yield* fulfil(claimed, captain, seats).pipe(
        // A failed spawn hands the gate back to the human rather than recording a phantom crew;
        // onError also fires on a defect, so an unexpected failure cannot leave it approved.
        Effect.onError(() => proposals.reopen(proposal.id).pipe(Effect.ignore)),
      );
      const final =
        (yield* proposals
          .attachInstance(proposal.id, instance.id)
          .pipe(Effect.mapError(operationError("recording the crew")))) ??
        ({ ...claimed, crewInstanceId: instance.id } satisfies CrewProposal);
      yield* notifyCaptain(final, instance, status);
      return { proposal: final, instance } satisfies CrewProposalOutcome;
    });

    const propose: CrewProposalServiceShape["propose"] = (input) =>
      Effect.gen(function* () {
        yield* validateSeats(input.seats, { seatNames: [], pendingSeats: 0 });
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
        const pendingSeats = (yield* proposals
          .listForCaptain(input.captain.participantId)
          .pipe(Effect.mapError(operationError("reading open proposals"))))
          .filter((open) => open.status === "open" && open.crewInstanceId === instance.id)
          .reduce((count, open) => count + open.requestedSeats.length, 0);
        yield* validateSeats([input.seat], {
          seatNames: instance.members.map(({ seatName }) => seatName),
          pendingSeats,
        });
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
            crewInstanceId: instance.id,
            kind: "addition",
            brief: input.brief ?? instance.brief,
            displayName: instance.displayName,
            requestedSeats: [input.seat],
            createdAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.mapError(operationError("recording the proposal")));
        if (proposal.status !== "open") {
          const current = yield* crews.read(instance.id).pipe(Effect.orDie);
          return { proposal, instance: current };
        }
        return { proposal, instance };
      });

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
          const declined = yield* proposals
            .resolve({
              id: proposal.id,
              status: "declined",
              approvedSeats: null,
              crewInstanceId: null,
              resolvedAt: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(Effect.mapError(operationError("recording the decline")));
          if (declined === null)
            return yield* new CrewProposalNotOpenError({
              proposalId: proposal.id,
              status: "declined",
            });
          // An earlier approval may have reserved these seats and failed before any agent
          // existed; declining releases those reservations so the Crew carries no phantom seat.
          if (proposal.kind === "addition" && proposal.crewInstanceId !== null)
            yield* crews
              .removeUnregisteredMembers(
                proposal.crewInstanceId,
                proposal.requestedSeats.map((seat) => seat.seat),
              )
              .pipe(Effect.mapError(operationError("releasing reserved seats")));
          yield* notifyCaptain(declined, null, "declined");
          return { proposal: declined, instance: null };
        }
        const seats = input.seats ?? proposal.requestedSeats;
        // The human may have renamed or added seats on the card; check them against the live
        // roster, or an approved duplicate would spawn a seat the snapshot cannot record.
        const existingMembers =
          proposal.crewInstanceId === null
            ? []
            : ((yield* crews
                .read(proposal.crewInstanceId)
                .pipe(Effect.mapError(operationError("reading the crew"))))?.members ?? []);
        // An addition reserves its member rows before the seats spawn. When that spawn failed
        // and the gate was handed back, the rows are still there under this proposal's own
        // deterministic ids; they are the reservation the retry converges on, not a clash
        // (Critic Q2, 2026-09-14).
        const reservedHere = (member: {
          readonly participantId: string;
          readonly seatName: string;
        }) =>
          member.participantId ===
          participantIdForThread(
            spawnThreadId({
              providerSessionId: PROPOSAL_SESSION,
              requestKey: crewSeatRequestKey(proposal.id, member.seatName),
            }),
          );
        yield* validateSeats(seats, {
          seatNames: existingMembers
            .filter((member) => !reservedHere(member))
            .map(({ seatName }) => seatName),
          pendingSeats: 0,
        });
        const captain = yield* captainFor(proposal);
        return yield* settle(proposal, captain, seats);
      });

    return CrewProposalService.of({ propose, requestMember, resolve });
  }),
);

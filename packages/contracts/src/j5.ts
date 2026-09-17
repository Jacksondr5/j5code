import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";

export const ScopedSquadronRef = Schema.Struct({
  environmentId: EnvironmentId,
  squadronId: Schema.String,
});
export type ScopedSquadronRef = typeof ScopedSquadronRef.Type;

export const scopedSquadronKey = (ref: ScopedSquadronRef): string =>
  JSON.stringify([ref.environmentId, ref.squadronId]);

export const ManagedSquadron = Schema.Struct({
  squadron: Schema.Struct({ id: Schema.String, name: Schema.String, createdAt: Schema.String }),
  projectIds: Schema.Array(ProjectId),
});
export type ManagedSquadron = typeof ManagedSquadron.Type;

export const SquadronListResponse = Schema.Struct({ squadrons: Schema.Array(ManagedSquadron) });
export const CreateSquadronRequest = Schema.Struct({ name: Schema.String, projectId: ProjectId });
export const CreateSquadronResponse = Schema.Struct({ squadron: ManagedSquadron });

export const ThreadHome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("known"),
    squadron: Schema.Struct({ id: Schema.String, name: Schema.String }),
    /** SB5: `agent` means another agent spawned this thread, so it is roster-only unless pinned. */
    origin: Schema.optional(Schema.Literals(["human", "agent"])),
  }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);
export type ThreadHome = typeof ThreadHome.Type;
export const ThreadHomeEntry = Schema.Struct({ threadId: ThreadId, home: ThreadHome });
export type ThreadHomeEntry = typeof ThreadHomeEntry.Type;
export const ThreadHomesRequest = Schema.Struct({ threadIds: Schema.Array(ThreadId) });
export const ThreadHomesResponse = Schema.Struct({ entries: Schema.Array(ThreadHomeEntry) });

export const HumanInboxItem = Schema.Struct({
  personId: Schema.String,
  squadronId: Schema.String,
  squadronName: Schema.String,
  exchangeId: Schema.String,
  senderId: Schema.String,
  senderThreadId: Schema.NullOr(Schema.String),
  intent: Schema.String,
  urgency: Schema.Literals(["blocking", "soon", "fyi"]),
  message: Schema.String,
  openedAt: Schema.String,
  status: Schema.Literals(["open", "answered"]),
  terminalAt: Schema.NullOr(Schema.String),
});
export type HumanInboxItem = typeof HumanInboxItem.Type;
export type ScopedHumanInboxItem = HumanInboxItem & { readonly environmentId: EnvironmentId };

export const scopedInboxItemKey = (item: ScopedHumanInboxItem): string =>
  JSON.stringify([item.environmentId, item.personId, item.squadronId, item.exchangeId]);

export const HumanInboxResponse = Schema.Struct({
  personId: Schema.String,
  items: Schema.Array(HumanInboxItem),
});
export type HumanInboxResponse = typeof HumanInboxResponse.Type;

export const AnswerHumanExchangeRequest = Schema.Struct({
  personId: Schema.String.check(Schema.isNonEmpty()),
  exchangeId: Schema.String.check(Schema.isNonEmpty()),
  message: Schema.String.check(Schema.isNonEmpty()),
  clientRequestId: Schema.String.check(Schema.isNonEmpty()),
});
export type AnswerHumanExchangeRequest = typeof AnswerHumanExchangeRequest.Type;
export const AnswerHumanExchangeResponse = Schema.Struct({
  result: Schema.Struct({
    messageId: Schema.String,
    exchangeId: Schema.NullOr(Schema.String),
    exchangeState: Schema.Literals(["none", "open", "closing", "closed"]),
    joinedExistingExchange: Schema.Boolean,
    durableAtSeq: Schema.Number,
  }),
});

export const OpenInboxCountResponse = Schema.Struct({
  personId: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** A Crew holds at most this many seats, initial roster and additions together (Crews AC11). */
export const CREW_SEAT_CAP = 12;

/**
 * One requested or approved Crew seat, as the Captain proposed it or the human edited it. A null
 * agent is a custom seat: no saved agent, it runs on the Captain's provider, model, and mode.
 */
export const CrewProposalSeat = Schema.Struct({
  seat: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  reason: Schema.String,
  instructions: Schema.optional(Schema.String),
});
export type CrewProposalSeat = typeof CrewProposalSeat.Type;

/** The human gate for one Crew request: a roster to launch or a seat to add to a live Crew. */
export const CrewProposal = Schema.Struct({
  id: Schema.String,
  squadronId: Schema.String,
  captainParticipantId: Schema.String,
  captainThreadId: Schema.String,
  crewInstanceId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["roster", "addition"]),
  status: Schema.Literals(["open", "approving", "declining", "approved", "declined"]),
  displayName: Schema.String,
  brief: Schema.String,
  requestedSeats: Schema.Array(CrewProposalSeat),
  approvedSeats: Schema.NullOr(Schema.Array(CrewProposalSeat)),
  createdAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});
export type CrewProposal = typeof CrewProposal.Type;
export type ScopedCrewProposal = CrewProposal & { readonly environmentId: EnvironmentId };

export const CrewProposalsResponse = Schema.Struct({ proposals: Schema.Array(CrewProposal) });
export const CrewProposalResolveRequest = Schema.Struct({
  proposalId: Schema.String,
  decision: Schema.Literals(["approve", "decline"]),
  seats: Schema.optional(Schema.Array(CrewProposalSeat).check(Schema.isMaxLength(CREW_SEAT_CAP))),
});
export type CrewProposalResolveRequest = typeof CrewProposalResolveRequest.Type;
export const CrewProposalResolveResponse = Schema.Struct({
  proposal: CrewProposal,
  crewInstanceId: Schema.NullOr(Schema.String),
});

/** A live Crew as the sidebar names it; retired Crews are omitted from the read, not flagged. */
export const CrewRef = Schema.Struct({
  crewInstanceId: Schema.String,
  crewName: Schema.String,
});
export type CrewRef = typeof CrewRef.Type;

/** What a sidebar row needs: which Crew a thread sits in, or which Crews it commands. */
export const ThreadCrewMembership = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("member"), seat: Schema.String, crew: CrewRef }),
  Schema.Struct({ kind: Schema.Literal("captain"), crews: Schema.Array(CrewRef) }),
]);
export type ThreadCrewMembership = typeof ThreadCrewMembership.Type;
export const CrewMembershipEntry = Schema.Struct({
  threadId: ThreadId,
  membership: ThreadCrewMembership,
});
export type CrewMembershipEntry = typeof CrewMembershipEntry.Type;
export const CrewMembershipsResponse = Schema.Struct({
  entries: Schema.Array(CrewMembershipEntry),
});

/** One agent placed directly under a visible thread, with its Crew seat when it has one. */
export const SpawnedChild = Schema.Struct({
  threadId: ThreadId,
  participantId: Schema.String,
  seat: Schema.NullOr(
    Schema.Struct({ crewInstanceId: Schema.String, crewName: Schema.String, seat: Schema.String }),
  ),
});
export type SpawnedChild = typeof SpawnedChild.Type;
export const SpawnedChildrenEntry = Schema.Struct({
  threadId: ThreadId,
  children: Schema.Array(SpawnedChild),
});
export type SpawnedChildrenEntry = typeof SpawnedChildrenEntry.Type;
export const SpawnedChildrenResponse = Schema.Struct({
  entries: Schema.Array(SpawnedChildrenEntry),
});

/**
 * A Crew as the Fleet page records it: the approved roster snapshot with who approved each seat
 * and why. Archived Crews keep their snapshot so a successor can be briefed from it (Crews AC20).
 */
export const FleetCrew = Schema.Struct({
  crewInstanceId: Schema.String,
  crewName: Schema.String,
  captainParticipantId: Schema.String,
  captainThreadId: Schema.NullOr(Schema.String),
  brief: Schema.String,
  version: Schema.Number,
  createdAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  /** Every seat was approved by the person; the record keeps the version it joined at and why. */
  roster: Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      agentId: Schema.NullOr(Schema.String),
      participantId: Schema.String,
      addedVersion: Schema.Number,
      reason: Schema.NullOr(Schema.String),
    }),
  ),
});
export type FleetCrew = typeof FleetCrew.Type;

/** One agent row of the Fleet page: placement, provenance, Crew seat, and measured open asks. */
export const FleetAgent = Schema.Struct({
  participantId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  /** `agent` when another agent spawned it (roster-only in the sidebar); `unknown` when never recorded. */
  origin: Schema.Literals(["human", "agent", "unknown"]),
  placementParentId: Schema.NullOr(Schema.String),
  crew: Schema.NullOr(
    Schema.Struct({
      crewInstanceId: Schema.String,
      crewName: Schema.String,
      seat: Schema.String,
      captainParticipantId: Schema.String,
    }),
  ),
  /** Open Exchanges this agent owes a reply on. */
  openAsks: Schema.Number,
  /** A retired agent kept only as a placeholder above an active descendant; never a live row. */
  archived: Schema.Boolean,
});
export type FleetAgent = typeof FleetAgent.Type;
export const FleetSquadron = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  agents: Schema.Array(FleetAgent),
  crews: Schema.Array(FleetCrew),
});
export type FleetSquadron = typeof FleetSquadron.Type;
/** The rail badge reads the live roster only; the Fleet page asks for retired Crews as well. */
export const FleetReadRequest = Schema.Struct({ includeRetired: Schema.optional(Schema.Boolean) });
export type FleetReadRequest = typeof FleetReadRequest.Type;
export const FleetResponse = Schema.Struct({ squadrons: Schema.Array(FleetSquadron) });
export type FleetResponse = typeof FleetResponse.Type;

/** A person stopping a Crew from the app: every running seat is interrupted, nothing is retired. */
export const CrewStopRequest = Schema.Struct({ crewInstanceId: Schema.String });
export type CrewStopRequest = typeof CrewStopRequest.Type;
export const CrewStopResponse = Schema.Struct({
  crewInstanceId: Schema.String,
  members: Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      participantId: Schema.String,
      result: Schema.Literals(["interrupt_requested", "already_idle", "archived"]),
    }),
  ),
});
export type CrewStopResponse = typeof CrewStopResponse.Type;

/** A live Crew the archived agent commands, seat by seat, as the archive dialog shows it. */
export const PreArchiveLiveCrew = Schema.Struct({
  crewInstanceId: Schema.String,
  crewName: Schema.String,
  seats: Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      participantId: Schema.String,
      runningTurn: Schema.Boolean,
      openAsks: Schema.Number,
    }),
  ),
});
export type PreArchiveLiveCrew = typeof PreArchiveLiveCrew.Type;
/** The Crew seat the archived agent holds; seats are never archived one by one. */
export const PreArchiveCrewSeat = Schema.Struct({
  crewInstanceId: Schema.String,
  crewName: Schema.String,
  seat: Schema.String,
});
export type PreArchiveCrewSeat = typeof PreArchiveCrewSeat.Type;

/**
 * A person retiring a Crew from the app, after a dialog that listed every seat's consequences:
 * the seats archive as one unit and nothing is deleted.
 */
export const CrewArchiveRequest = Schema.Struct({ crewInstanceId: Schema.String });
export type CrewArchiveRequest = typeof CrewArchiveRequest.Type;
export const CrewArchiveResponse = Schema.Struct({
  crewInstanceId: Schema.String,
  status: Schema.Literals(["archived", "already_archived"]),
  members: Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      participantId: Schema.String,
      result: Schema.Literals(["archived", "already_archived"]),
    }),
  ),
});
export type CrewArchiveResponse = typeof CrewArchiveResponse.Type;

export const J5_API_PATHS = {
  squadrons: "/api/j5/squadrons",
  threadHomes: "/api/j5/a2a/client-reads/participant-homes",
  inbox: "/api/j5/a2a/inbox",
  answer: "/api/j5/a2a/inbox/answer",
  openCount: "/api/j5/a2a/client-reads/open-count",
  crewProposals: "/api/j5/a2a/crews/proposals",
  crewProposalResolve: "/api/j5/a2a/crews/proposals/resolve",
  crewStop: "/api/j5/a2a/crews/stop",
  crewArchive: "/api/j5/a2a/crews/archive",
  fleet: "/api/j5/a2a/client-reads/fleet",
  crewMemberships: "/api/j5/a2a/client-reads/crew-memberships",
  spawnedChildren: "/api/j5/a2a/client-reads/spawned-children",
} as const;

/**
 * Machine participants: registered non-agent senders (cron jobs, watchdogs,
 * shell scripts) that send plain messages into a Squadron and never receive.
 * Their ids are `machine:<name>`; the name is server-unique.
 */
export const MACHINE_PARTICIPANT_ID_PREFIX = "machine:" as const;
export const MachineParticipantName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
);
export type MachineParticipantName = typeof MachineParticipantName.Type;
export const machineParticipantIdForName = (name: string): string =>
  `${MACHINE_PARTICIPANT_ID_PREFIX}${name}`;

export const MachineParticipantRecord = Schema.Struct({
  participantId: Schema.String,
  squadronId: Schema.String,
  squadronName: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
});
export type MachineParticipantRecord = typeof MachineParticipantRecord.Type;

export const RegisterMachineParticipantRequest = Schema.Struct({
  squadronId: Schema.String.check(Schema.isNonEmpty()),
  name: MachineParticipantName,
});
export type RegisterMachineParticipantRequest = typeof RegisterMachineParticipantRequest.Type;
export const RegisterMachineParticipantResponse = Schema.Struct({
  participant: MachineParticipantRecord,
  created: Schema.Boolean,
});
export type RegisterMachineParticipantResponse = typeof RegisterMachineParticipantResponse.Type;

/** `to` is a participant id, a thread id, or an agent's display name. */
export const MachineSendRequest = Schema.Struct({
  to: Schema.String.check(Schema.isNonEmpty()),
  message: Schema.String.check(Schema.isNonEmpty()),
  clientRequestId: Schema.String.check(Schema.isNonEmpty()),
});
export type MachineSendRequest = typeof MachineSendRequest.Type;
export const MachineSendResponse = Schema.Struct({
  sender: Schema.String,
  receiver: Schema.String,
  result: Schema.Struct({
    messageId: Schema.String,
    exchangeId: Schema.NullOr(Schema.String),
    exchangeState: Schema.Literals(["none", "open", "closing", "closed"]),
    joinedExistingExchange: Schema.Boolean,
    durableAtSeq: Schema.Number,
  }),
});
export type MachineSendResponse = typeof MachineSendResponse.Type;

export const A2ARosterLiveness = Schema.Struct({
  /** Derived: active while a run is in flight, errored after a failed run, otherwise idle. */
  state: Schema.Literals(["idle", "active", "errored"]),
  /** The thread's measured shell status, verbatim. */
  runStatus: Schema.String,
  latestRunStartedAt: Schema.NullOr(Schema.String),
  latestRunCompletedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
export type A2ARosterLiveness = typeof A2ARosterLiveness.Type;

export const A2ARosterEntry = Schema.Struct({
  participantId: Schema.String,
  kind: Schema.Literals(["agent", "human", "machine"]),
  squadronId: Schema.NullOr(Schema.String),
  squadronName: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  archived: Schema.Boolean,
  canReceiveMessage: Schema.Boolean,
  acceptsUrgency: Schema.Boolean,
  /** Present for agents whose thread is in the shell snapshot; null otherwise. */
  liveness: Schema.NullOr(A2ARosterLiveness),
});
export type A2ARosterEntry = typeof A2ARosterEntry.Type;
export const A2ARosterResponse = Schema.Struct({ participants: Schema.Array(A2ARosterEntry) });
export type A2ARosterResponse = typeof A2ARosterResponse.Type;

export const MachineWhoamiResponse = Schema.Struct({
  participant: MachineParticipantRecord,
  server: Schema.Struct({ version: Schema.String }),
});
export type MachineWhoamiResponse = typeof MachineWhoamiResponse.Type;

export const J5_MACHINE_API_PATHS = {
  machineParticipants: "/api/j5/a2a/machine-participants",
  send: "/api/j5/a2a/send",
  roster: "/api/j5/a2a/roster",
  whoami: "/api/j5/a2a/whoami",
} as const;

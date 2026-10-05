import * as Schema from "effect/Schema";
export * from "./j5/playbook.ts";

import { ModelSelection } from "./modelSelection.ts";
import {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeMode,
} from "./providerPolicy.ts";
import { EnvironmentId, ProjectId, RuntimeRequestId, ThreadId } from "./baseSchemas.ts";
import { AgentPersonaId } from "./j5/agentPersona.ts";

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
export const RenameSquadronRequest = Schema.Struct({ name: Schema.String });
export const RenameSquadronResponse = Schema.Struct({ squadron: ManagedSquadron });
export const DeleteSquadronResponse = Schema.Struct({
  deleted: Schema.Literal(true),
  squadronId: Schema.String,
});

export const AssignImportedThreadsRequest = Schema.Struct({
  squadronId: Schema.String.check(Schema.isNonEmpty()),
  projectId: ProjectId,
});
export type AssignImportedThreadsRequest = typeof AssignImportedThreadsRequest.Type;
export const AssignImportedThreadsResponse = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      status: Schema.Literals([
        "assigned",
        "already_assigned",
        "kept_elsewhere",
        "kept_retired",
        "kept_archived",
        "failed",
      ]),
    }),
  ),
});
export type AssignImportedThreadsResponse = typeof AssignImportedThreadsResponse.Type;

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
 * A step whose persona differs from the persona of the seat that owns it. `seatPersona` is null
 * for a custom seat; `wantedProblem` says why the wanted persona could not staff the step itself.
 */
export const CrewPersonaSwap = Schema.Struct({
  stepId: Schema.String,
  wanted: AgentPersonaId,
  seatPersona: Schema.NullOr(AgentPersonaId),
  wantedProblem: Schema.NullOr(Schema.Literals(["missing", "disabled"])),
});
export type CrewPersonaSwap = typeof CrewPersonaSwap.Type;

/**
 * Where a Crew seat works, chosen for every seat: the Captain's own checkout (`shared`), a new
 * worktree the server prepares from `baseRef` before the seat's brief starts, or one of the
 * project's existing worktrees. On a preview's seat runtime it is the resolved choice; an existing
 * worktree's `branch` is then the one git has checked out there.
 */
export const CrewSeatWorkspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("shared") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: Schema.String,
    branch: Schema.optionalKey(Schema.String),
    startFromOrigin: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: Schema.String,
    branch: Schema.optionalKey(Schema.String),
  }),
]);
export type CrewSeatWorkspace = typeof CrewSeatWorkspace.Type;

/** What the roster card offers when a seat's workspace is edited, read from the Captain's repo. */
export const CrewWorkspaceOptions = Schema.Struct({
  /** The branch checked out where the Captain works, to prefill a new worktree's base. */
  currentBranch: Schema.NullOr(Schema.String),
  /** The first page of local branches; `branchesTruncated` says there are more. */
  branches: Schema.Array(Schema.String),
  branchesTruncated: Schema.Boolean,
  /** The project's worktrees other than its main checkout, each with its branch. */
  worktrees: Schema.Array(Schema.Struct({ path: Schema.String, branch: Schema.String })),
});
export type CrewWorkspaceOptions = typeof CrewWorkspaceOptions.Type;

/**
 * One requested or approved Crew seat, as the Captain proposed it or the human edited it. A null
 * agent is a custom seat. Human runtime edits apply to every seat; omitted fields use the persona
 * defaults or, for a custom seat, inherit the Captain.
 */
export const CrewProposalSeat = Schema.Struct({
  seat: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  reason: Schema.String,
  instructions: Schema.optional(Schema.String),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  /** Ids of the playbook steps this seat owns; only on a Crew that follows a playbook. */
  steps: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Every seat proposed now names one; only seats recorded before workspaces were required lack
   * it, and the server refuses to launch those until one is chosen.
   */
  workspace: Schema.optionalKey(CrewSeatWorkspace),
  /** Computed by the server at propose and approve; a client's value is ignored. */
  personaSwaps: Schema.optionalKey(Schema.Array(CrewPersonaSwap)),
});
export type CrewProposalSeat = typeof CrewProposalSeat.Type;

/** The playbook a proposal follows, read live from its YAML; `issue` says why it cannot be read. */
export const CrewProposalPlaybook = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      persona: Schema.optionalKey(AgentPersonaId),
    }),
  ),
  issue: Schema.NullOr(Schema.String),
});
export type CrewProposalPlaybook = typeof CrewProposalPlaybook.Type;

/** The human gate for one Crew request: a roster to launch or a seat to add to a live Crew. */
export const CrewProposal = Schema.Struct({
  id: Schema.String,
  squadronId: Schema.String,
  captainParticipantId: Schema.String,
  captainThreadId: Schema.String,
  crewInstanceId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["roster", "addition"]),
  status: Schema.Literals(["open", "approved", "declined"]),
  displayName: Schema.String,
  brief: Schema.String,
  requestedSeats: Schema.Array(CrewProposalSeat),
  approvedSeats: Schema.NullOr(Schema.Array(CrewProposalSeat)),
  createdAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
  playbook: Schema.optionalKey(Schema.NullOr(CrewProposalPlaybook)),
});
export type CrewProposal = typeof CrewProposal.Type;
export type ScopedCrewProposal = CrewProposal & { readonly environmentId: EnvironmentId };

export const CrewProposalsResponse = Schema.Struct({ proposals: Schema.Array(CrewProposal) });
/** Server-resolved runtime, displayed verbatim before a human approves this exact roster. */
export const CrewProposalSeatRuntime = Schema.Struct({
  seat: Schema.String,
  provider: Schema.String,
  harness: Schema.String,
  model: Schema.String,
  reasoning: Schema.String,
  access: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workspace: CrewSeatWorkspace,
  /** The seat's persona swaps as the edited roster would record them. */
  personaSwaps: Schema.optionalKey(Schema.Array(CrewPersonaSwap)),
});
export type CrewProposalSeatRuntime = typeof CrewProposalSeatRuntime.Type;
export const CrewProposalPreviewRequest = Schema.Struct({
  proposalId: Schema.String,
  seats: Schema.optional(Schema.Array(CrewProposalSeat).check(Schema.isMaxLength(CREW_SEAT_CAP))),
});
export type CrewProposalPreviewRequest = typeof CrewProposalPreviewRequest.Type;
export const CrewProposalPreviewResponse = Schema.Struct({
  proposalId: Schema.String,
  approvalToken: Schema.String,
  seats: Schema.Array(CrewProposalSeatRuntime),
  workspaceOptions: CrewWorkspaceOptions,
  /** The plan the approval token binds: the live playbook and the steps no seat owns. */
  playbook: Schema.optionalKey(Schema.NullOr(CrewProposalPlaybook)),
  unownedSteps: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type CrewProposalPreviewResponse = typeof CrewProposalPreviewResponse.Type;

export const CrewProposalResolveRequest = Schema.Union([
  Schema.Struct({
    proposalId: Schema.String,
    decision: Schema.Literal("approve"),
    approvalToken: Schema.String,
    seats: Schema.optional(Schema.Array(CrewProposalSeat).check(Schema.isMaxLength(CREW_SEAT_CAP))),
  }),
  Schema.Struct({
    proposalId: Schema.String,
    decision: Schema.Literal("decline"),
  }),
]);
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
 * A Crew as the Fleet page records it: the approved roster snapshot with why each seat joined;
 * every seat was approved by the person. Archived Crews keep their snapshot so a successor can be
 * briefed from it (Crews AC20).
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
  /** The playbook the Crew follows, fixed at approval. */
  playbook: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  /** Every seat was approved by the person; the record keeps the version it joined at and why. */
  roster: Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      agentId: Schema.NullOr(Schema.String),
      participantId: Schema.String,
      addedVersion: Schema.Number,
      reason: Schema.NullOr(Schema.String),
      /** Ids of the playbook steps this seat owns. */
      steps: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  /**
   * The Crew's active playbook run: where it is and who holds the current step. `state` has the
   * meaning of `PlaybookStepDelivery.state`; only `"captain"` means the Captain does the step.
   */
  playbookRun: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        runId: Schema.String,
        position: Schema.Number,
        total: Schema.Number,
        stepId: Schema.String,
        stepTitle: Schema.String,
        state: Schema.Literals(["delivered", "captain", "pending"]),
        seat: Schema.NullOr(Schema.String),
        /** Set when the live playbook can't be read or lacks the step; position is then 0. */
        issue: Schema.optionalKey(Schema.String),
      }),
    ),
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
  assignImportedThreads: "/api/j5/squadrons/assign-imported",
  threadHomes: "/api/j5/a2a/client-reads/participant-homes",
  inbox: "/api/j5/a2a/inbox",
  answer: "/api/j5/a2a/inbox/answer",
  openCount: "/api/j5/a2a/client-reads/open-count",
  crewProposals: "/api/j5/a2a/crews/proposals",
  crewProposalPreview: "/api/j5/a2a/crews/proposals/preview",
  crewProposalResolve: "/api/j5/a2a/crews/proposals/resolve",
  crewStop: "/api/j5/a2a/crews/stop",
  crewArchive: "/api/j5/a2a/crews/archive",
  crewRuntimeRequests: "/api/j5/a2a/crews/runtime-requests",
  crewRuntimeRequestRespond: "/api/j5/a2a/crews/runtime-requests/respond",
  fleet: "/api/j5/a2a/client-reads/fleet",
  crewMemberships: "/api/j5/a2a/client-reads/crew-memberships",
  spawnedChildren: "/api/j5/a2a/client-reads/spawned-children",
} as const;

/**
 * Action path for one Squadron; ids carry a colon so they are encoded. Both
 * actions are POST so cross-origin browser clients pass the CORS allowlist.
 */
export const j5SquadronActionPath = (squadronId: string, action: "rename" | "delete"): string =>
  `${J5_API_PATHS.squadrons}/${encodeURIComponent(squadronId)}/${action}`;

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

/**
 * A provider approval waiting on a live Crew seat's thread. Seats run while the person watches
 * the Captain, so their approvals reach the Inbox instead of waiting unseen in the seat's composer
 * (Crews AC9); the Captain's own requests stay inline in its thread. Read live from the thread's
 * projection, and only while the provider can still take the answer. The approval fields match
 * the composer's `ThreadPendingApproval`, so the composer's approval UI renders it.
 */
export const CrewRuntimeRequestItem = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  crewInstanceId: Schema.String,
  crewName: Schema.String,
  squadronId: Schema.String,
  seat: Schema.String,
  threadTitle: Schema.String,
  createdAt: Schema.String,
  requestKind: ProviderRequestKind,
  detail: Schema.optionalKey(Schema.String),
  appName: Schema.optionalKey(Schema.String),
  /** The provider's advertised choices; absent means the composer's defaults. */
  options: Schema.optionalKey(Schema.Array(ProviderApprovalOption)),
});
export type CrewRuntimeRequestItem = typeof CrewRuntimeRequestItem.Type;
export const CrewRuntimeRequestsResponse = Schema.Struct({
  requests: Schema.Array(CrewRuntimeRequestItem),
});
export type CrewRuntimeRequestsResponse = typeof CrewRuntimeRequestsResponse.Type;

/** A decision on a seat's approval, sent from the Inbox. */
export const CrewRuntimeRequestRespondRequest = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  decision: ProviderApprovalDecision,
});
export type CrewRuntimeRequestRespondRequest = typeof CrewRuntimeRequestRespondRequest.Type;
export const CrewRuntimeRequestRespondResponse = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
});
export type CrewRuntimeRequestRespondResponse = typeof CrewRuntimeRequestRespondResponse.Type;

/**
 * Peering: two servers that exchange agent messages. A peer holds a session of
 * the other server whose subject is `peer:<its own environment id>` and whose
 * only scope is `a2a:peer`. Records are mutual and pairwise; the client that is
 * connected to both environments introduces them.
 */
const PEER_SUBJECT_PREFIX = "peer:" as const;
export const peerSubjectForEnvironment = (environmentId: string): string =>
  `${PEER_SUBJECT_PREFIX}${environmentId}`;
export const environmentIdFromPeerSubject = (subject: string): string | null =>
  subject.startsWith(PEER_SUBJECT_PREFIX) && subject.length > PEER_SUBJECT_PREFIX.length
    ? subject.slice(PEER_SUBJECT_PREFIX.length)
    : null;

/** An http(s) origin with no path, query, or fragment. */
export const PeerOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        ((url.protocol === "http:" || url.protocol === "https:") &&
          url.pathname === "/" &&
          url.search === "" &&
          url.hash === "" &&
          !value.endsWith("/")) ||
        "A peer origin must be an http(s) origin such as https://home.example:3773 with no path."
      );
    } catch {
      return "A peer origin must be an http(s) origin such as https://home.example:3773 with no path.";
    }
  }),
);
export type PeerOrigin = typeof PeerOrigin.Type;

export const PeerRecord = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  origin: Schema.String,
  /** When the credential the peer issued to this server expires, as the peer reported it at hello. */
  credentialExpiresAt: Schema.NullOr(Schema.String),
  /** Whether the peer still holds a live session here; "missing" means it was revoked or expired and its deliveries are refused. */
  inboundSession: Schema.Literals(["active", "missing"]),
  createdAt: Schema.String,
});
export type PeerRecord = typeof PeerRecord.Type;
export const PeerListResponse = Schema.Struct({ peers: Schema.Array(PeerRecord) });
export type PeerListResponse = typeof PeerListResponse.Type;

/** Mint a credential the named environment will present when it delivers to this server. */
export const IssuePeerCredentialRequest = Schema.Struct({
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  label: Schema.optional(Schema.String),
});
export type IssuePeerCredentialRequest = typeof IssuePeerCredentialRequest.Type;
export const IssuePeerCredentialResponse = Schema.Struct({
  /** This server's environment id, which the holder records as the peer's id. */
  environmentId: Schema.String,
  credential: Schema.String,
  sessionId: Schema.String,
  subject: Schema.String,
  expiresAt: Schema.String,
});
export type IssuePeerCredentialResponse = typeof IssuePeerCredentialResponse.Type;

/** Record a peer after proving the credential at the origin; the peer names itself in the hello. */
export const AddPeerRequest = Schema.Struct({
  origin: PeerOrigin,
  credential: Schema.String.check(Schema.isNonEmpty()),
  label: Schema.optional(Schema.String),
  /** A known peer keeps its recorded origin unless the caller says to move it. */
  replaceOrigin: Schema.optional(Schema.Boolean),
});
export type AddPeerRequest = typeof AddPeerRequest.Type;
export const AddPeerResponse = Schema.Struct({ peer: PeerRecord, created: Schema.Boolean });
export type AddPeerResponse = typeof AddPeerResponse.Type;

export const RemovePeerRequest = Schema.Struct({
  environmentId: Schema.String.check(Schema.isNonEmpty()),
});
export type RemovePeerRequest = typeof RemovePeerRequest.Type;
export const RemovePeerResponse = Schema.Struct({
  removed: Schema.Boolean,
  revokedSessions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type RemovePeerResponse = typeof RemovePeerResponse.Type;

/** What a server answers to a peer credential: who it is and whom the credential names. */
export const PeerHelloResponse = Schema.Struct({
  environmentId: Schema.String,
  subject: Schema.String,
  /** When the credential used for this hello expires; null when the session never expires. */
  credentialExpiresAt: Schema.optional(Schema.NullOr(Schema.String)),
  server: Schema.Struct({ version: Schema.String }),
});
export type PeerHelloResponse = typeof PeerHelloResponse.Type;

/**
 * One message crossing from a peer server. The receiving server records its own
 * received row (and the Exchange fact an ask or reply implies) before it
 * delivers locally; a retry with the same message id replays the first receipt.
 */
/**
 * The closing fact a terminal notice carries between servers. A dropped
 * Exchange names the retirement; a withdrawn ask says only that the asker
 * cleared it. The receiver works out the disposition from its own copy of
 * the Exchange, so the wire never says which side the retired party was on.
 */
export const PeerTerminalFact = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("dropped"),
    cause: Schema.Struct({
      kind: Schema.Literals(["participant-archived", "participant-deleted"]),
      participantId: Schema.String,
      squadronId: Schema.String,
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("sender-cleared") }),
]);
export type PeerTerminalFact = typeof PeerTerminalFact.Type;

/** Peer-supplied strings are bounded: a peer names a sender, it does not get to fill the ledger. */
export const PEER_SENDER_LABEL_MAX_CHARS = 200;
/** One cap for a message's text, enforced at send so nothing is recorded that a peer would refuse. */
export const A2A_MESSAGE_TEXT_MAX_CHARS = 256_000;
export const PeerSenderLabel = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(PEER_SENDER_LABEL_MAX_CHARS),
);

export const PeerDeliveryRequest = Schema.Struct({
  messageId: Schema.String.check(Schema.isNonEmpty()),
  senderId: Schema.String.check(Schema.isNonEmpty()),
  receiverId: Schema.String.check(Schema.isNonEmpty()),
  exchangeId: Schema.NullOr(Schema.String.check(Schema.isNonEmpty())),
  correlationId: Schema.String.check(Schema.isNonEmpty()),
  exchangeRole: Schema.Literals(["none", "ask", "followup", "reply", "terminal_notice"]),
  envelopeChannel: Schema.Literals(["peer", "silence_notice", "lifecycle_notice"]),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(A2A_MESSAGE_TEXT_MAX_CHARS)),
  originSquadronId: Schema.String.check(Schema.isNonEmpty()),
  /**
   * The sender's display name (its thread title) for the receiving side's
   * people, so a timeline names a remote sender as it names a local one.
   * Agents keep addressing by id.
   */
  senderLabel: Schema.optional(PeerSenderLabel),
  /** Required when `exchangeRole` is `ask`: the Exchange the receiver now owes a reply to. */
  intent: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /**
   * Present on a `terminal_notice`: the closing fact the origin recorded, so the
   * peer ends its own copy of the Exchange the same way.
   */
  terminal: Schema.optional(PeerTerminalFact),
  /**
   * Present on a silence notice: the open Exchange whose answerer went quiet.
   * The notice is not part of that Exchange; the receiver accepts it only when
   * the Exchange is open here with this peer as its other party.
   */
  regardingExchangeId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /** The origin's clock, kept for display; the receiving server stamps its own time on what it records. */
  createdAt: Schema.String.check(
    Schema.makeFilter(
      (value) => !Number.isNaN(Date.parse(value)) || "createdAt must be an ISO-8601 timestamp.",
    ),
  ),
});
export type PeerDeliveryRequest = typeof PeerDeliveryRequest.Type;

/** The one thing a peer may read here: the agents it could address, and nothing about people or machines. */
export const PeerRosterAgent = Schema.Struct({
  participantId: Schema.String,
  squadronId: Schema.String,
  squadronName: Schema.String,
  threadId: ThreadId,
  displayName: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  canReceiveMessage: Schema.Boolean,
});
export type PeerRosterAgent = typeof PeerRosterAgent.Type;
export const PeerRosterResponse = Schema.Struct({ agents: Schema.Array(PeerRosterAgent) });
export type PeerRosterResponse = typeof PeerRosterResponse.Type;
export const PeerDeliveryResponse = Schema.Struct({
  accepted: Schema.Literal(true),
  receivedSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** True when this message id had already been recorded; nothing was written twice. */
  replay: Schema.Boolean,
});
export type PeerDeliveryResponse = typeof PeerDeliveryResponse.Type;

export const J5_PEER_API_PATHS = {
  peers: "/api/j5/a2a/peers",
  credentials: "/api/j5/a2a/peers/credentials",
  remove: "/api/j5/a2a/peers/remove",
  hello: "/api/j5/a2a/peers/hello",
  roster: "/api/j5/a2a/peers/roster",
  deliver: "/api/j5/a2a/peers/deliver",
} as const;

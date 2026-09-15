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

export const J5_API_PATHS = {
  squadrons: "/api/j5/squadrons",
  threadHomes: "/api/j5/a2a/client-reads/participant-homes",
  inbox: "/api/j5/a2a/inbox",
  answer: "/api/j5/a2a/inbox/answer",
  openCount: "/api/j5/a2a/client-reads/open-count",
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

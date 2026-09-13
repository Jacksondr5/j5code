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

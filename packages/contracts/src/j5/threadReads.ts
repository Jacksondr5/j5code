import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { CommandId, IsoDateTime, ThreadId } from "../baseSchemas.ts";
import { J5ActionError } from "./actionError.ts";

export const J5_THREAD_READ_WS_METHODS = {
  visit: "j5.threadReads.visit",
  markUnread: "j5.threadReads.markUnread",
  subscribe: "j5.threadReads.subscribe",
} as const;

export const PersonalThreadRead = Schema.Struct({
  threadId: ThreadId,
  lastVisitedAt: Schema.DateTimeUtc,
});
export type PersonalThreadRead = typeof PersonalThreadRead.Type;

export const PersonalThreadReadChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), markers: Schema.Array(PersonalThreadRead) }),
  Schema.Struct({ kind: Schema.Literal("changed"), marker: PersonalThreadRead }),
]);
export type PersonalThreadReadChange = typeof PersonalThreadReadChange.Type;

export const PersonalThreadVisit = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  visitedAt: IsoDateTime,
  opened: Schema.optional(Schema.Boolean),
  searchQuery: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type PersonalThreadVisit = typeof PersonalThreadVisit.Type;

export const PersonalThreadMarkUnread = Schema.Struct({ commandId: CommandId, threadId: ThreadId });
export type PersonalThreadMarkUnread = typeof PersonalThreadMarkUnread.Type;

const ReadError = Schema.Union([J5ActionError, EnvironmentAuthorizationError]);

export const J5ThreadReadsRpcGroup = RpcGroup.make(
  Rpc.make(J5_THREAD_READ_WS_METHODS.visit, {
    payload: PersonalThreadVisit,
    success: PersonalThreadRead,
    error: ReadError,
  }),
  Rpc.make(J5_THREAD_READ_WS_METHODS.markUnread, {
    payload: PersonalThreadMarkUnread,
    success: PersonalThreadRead,
    error: ReadError,
  }),
  Rpc.make(J5_THREAD_READ_WS_METHODS.subscribe, {
    payload: Schema.Struct({}),
    success: PersonalThreadReadChange,
    error: ReadError,
    stream: true,
  }),
);

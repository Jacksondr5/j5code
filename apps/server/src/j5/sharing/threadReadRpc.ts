import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  J5_THREAD_READ_WS_METHODS,
  type PersonalThreadVisit,
  type PersonalThreadMarkUnread,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { failAsJ5ActionError } from "../rpcActionError.ts";
import type { SessionIdentity } from "./PersonAccess.ts";
import { ThreadReadState } from "./ThreadReadState.ts";

export const THREAD_READ_RPC_SCOPES = {
  [J5_THREAD_READ_WS_METHODS.visit]: AuthOrchestrationReadScope,
  [J5_THREAD_READ_WS_METHODS.markUnread]: AuthOrchestrationReadScope,
  [J5_THREAD_READ_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
} as const;

const refused = failAsJ5ActionError({
  refusals: ["ThreadReadStateError"],
  failed: "Could not read or save your thread read state.",
});

export const makeThreadReadRpcHandlers = Effect.fn("ThreadReadState.rpc")(function* (
  session: SessionIdentity,
) {
  const reads = yield* ThreadReadState;
  return {
    [J5_THREAD_READ_WS_METHODS.visit]: (input: PersonalThreadVisit) =>
      reads.visit(session, input).pipe(Effect.catch(refused)),
    [J5_THREAD_READ_WS_METHODS.markUnread]: (input: PersonalThreadMarkUnread) =>
      reads.markUnread(session, input).pipe(Effect.catch(refused)),
    [J5_THREAD_READ_WS_METHODS.subscribe]: () =>
      reads.subscribe(session).pipe(Stream.catch((cause) => Stream.fromEffect(refused(cause)))),
  };
});

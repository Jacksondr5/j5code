import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Calls to a server that holds a line here, which failed because it did not answer. Each thread
 * that made one is told once, when that server's line is next up, which calls failed and when;
 * the agent decides what to retry. Its own file, so upstream's MCP tool layer can reach it without
 * importing J5's ledger.
 */
export interface UnreachableCallsShape {
  /** Runs a call an agent made to a linked server, noting it when the server did not answer. */
  readonly observe: <A, E, R>(
    input: {
      readonly threadId: ThreadId | undefined;
      readonly environmentId: string;
      /** The tool the agent called, which the notice names. */
      readonly tool: string;
    },
    call: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class UnreachableCalls extends Context.Service<UnreachableCalls, UnreachableCallsShape>()(
  "t3/j5/a2a/line/UnreachableCallsService/UnreachableCalls",
) {}

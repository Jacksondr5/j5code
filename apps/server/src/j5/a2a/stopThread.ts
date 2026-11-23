import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { DispatchModeLimit, type DispatchModes } from "../../orchestration-v2/DispatchModeLimit.ts";
import type { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";

/**
 * The reason an agent's Stop records, worded as upstream's MCP stops word theirs
 * (`agentStopReason` in `mcp/OrchestratorMcpService.ts`). Without one, the timeline reads
 * "Stopped by user".
 */
export const AGENT_STOP_REASON = "Stopped by an agent";

/** An agent's own reason, worded as upstream's MCP interrupt words it. */
export const agentStopReason = (reason: string | undefined) =>
  reason === undefined ? AGENT_STOP_REASON : `${AGENT_STOP_REASON}: ${reason}`;

/**
 * Upstream's Stop for one thread, as its MCP handler sends it. `thread.stop` stops delegated tasks
 * only when one has a thread here; `stopDelegatedTasks` also ends those on a linked machine. A
 * retry with the same `commandId` repeats only the stops that failed.
 */
export const stopThread = Effect.fn("j5.a2a.stopThread")(function* (
  threads: Pick<ThreadManagementService["Service"], "dispatch" | "stopDelegatedTasks">,
  input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly reason?: string | undefined;
  },
  /**
   * The broadest modes the stopper may touch, for upstream to check under the thread's lock when
   * it applies the Stop. Absent for a person, and for a Captain stopping its own Crew's seat.
   * It gates the thread named here and not its delegated tasks.
   */
  limit?: DispatchModes,
) {
  const stopped = yield* threads
    .dispatch({ type: "thread.stop", ...input })
    .pipe(Effect.provideService(DispatchModeLimit, limit));
  yield* threads.stopDelegatedTasks(input);
  return stopped;
});

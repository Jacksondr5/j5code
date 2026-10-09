import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";

/**
 * Upstream's Stop for one thread, as its own senders issue it: `thread.stop` interrupts the
 * running turn, holds the queue and ends pull request watches, then the thread's delegated tasks
 * are stopped. Nothing to stop is an accepted no-op, and a retry with the same `commandId`
 * repeats nothing. `stop_agent`, Crew stop and Crew retirement all stop a thread this way.
 */
export const stopThread = (
  threads: Pick<ThreadManagementService["Service"], "dispatch" | "stopDelegatedTasks">,
  input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly reason?: string | undefined;
  },
) =>
  threads
    .dispatch({ type: "thread.stop", ...input })
    .pipe(Effect.andThen(threads.stopDelegatedTasks(input)));

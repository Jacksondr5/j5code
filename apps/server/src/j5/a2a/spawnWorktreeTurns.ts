import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import type { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";

/**
 * The create command id of a spawn thread that asked for a worktree of its own. It derives from
 * the thread id alone, so a guard holding only the thread can find the receipt recording the ask.
 */
export const spawnWorktreeCreateCommandId = (threadId: ThreadId) =>
  CommandId.make(`command:j5:a2a:spawn-create-worktree:${encodeURIComponent(threadId)}`);

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/**
 * Why a message to this thread can't start a turn, or null when it can. A thread J5 spawned to
 * work in a worktree of its own has none until ThreadLaunch binds it, and none at all when that
 * preparation failed or was cancelled. Upstream reads a thread with no worktree as the project
 * root, so an ordinary turn then would run in the caller's checkout: the collision the worktree
 * was asked for to avoid. While the worktree is still being prepared, a message is accepted and
 * queues behind the brief, which ThreadLaunch holds as a preparing run and releases only once the
 * worktree is bound; the brief itself is exempt for the same reason. Only a thread whose
 * preparation is over without a worktree is refused.
 */
export const unboundWorktreeTurnRefusal = (
  receipts: CommandReceiptStoreV2["Service"],
  projections: ProjectionStoreV2["Service"],
  thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath" | "createdBy" | "creationSource">,
  command: Pick<MessageDispatch, "dispatchMode">,
) => {
  if (
    thread.worktreePath !== null ||
    command.dispatchMode?.type === "defer_start" ||
    thread.createdBy !== "agent" ||
    thread.creationSource !== "mcp"
  )
    return Effect.succeed(null);
  return Effect.gen(function* () {
    const asked = yield* receipts.getByCommandId(spawnWorktreeCreateCommandId(thread.id));
    if (Option.isNone(asked) || asked.value.status !== "accepted") return null;
    const { runs } = yield* projections.getThreadRecords(thread.id, ["runs"]);
    if (runs.some((run) => run.status === "preparing")) return null;
    return `Thread ${thread.id} was spawned to work in its own worktree, and preparing it failed, so it has none (the thread's first turn says why). It takes no turns in the project's checkout. Spawn a fresh agent instead.`;
  });
};

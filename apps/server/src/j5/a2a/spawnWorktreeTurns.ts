import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";

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
 * was asked for to avoid. The brief itself is exempt; ThreadLaunch holds it as a preparing run
 * that is released only once the worktree is bound.
 */
export const unboundWorktreeTurnRefusal = (
  receipts: CommandReceiptStoreV2["Service"],
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
  return receipts
    .getByCommandId(spawnWorktreeCreateCommandId(thread.id))
    .pipe(
      Effect.map((receipt) =>
        Option.isSome(receipt) && receipt.value.status === "accepted"
          ? `Thread ${thread.id} was spawned to work in its own worktree and has none: it is still being prepared, or its preparation failed (the thread's first turn says which). It takes no turns in the project's checkout. Wait for the worktree, or spawn a fresh agent.`
          : null,
      ),
    );
};

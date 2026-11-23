import type {
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { useThreadShell } from "../../state/entities";
import { useEnvironmentThread } from "../../state/threads";

const NO_PULL_REQUESTS: ReadonlyArray<ThreadPullRequestLink> = [];

/**
 * The asking agent's thread as an ask needs it: its shell, or, when the client holds no shell for
 * it and `load` is set, the thread itself, loaded rather than guessed from the project root. The
 * only read that has it is the thread's whole detail stream, so callers set `load` only for an ask
 * someone is reading.
 */
export function useSenderThread(ref: ScopedThreadRef | null, load: boolean) {
  const shell = useThreadShell(ref);
  const loadDetail = shell === null && load && ref !== null;
  const detail = useEnvironmentThread(
    loadDetail ? ref.environmentId : null,
    loadDetail ? ref.threadId : null,
  );
  const thread = shell ?? Option.getOrNull(detail.data)?.thread ?? null;
  const settled =
    detail.status === "live" || detail.status === "deleted" || Option.isSome(detail.error);
  return {
    known: thread !== null,
    /** The thread is being loaded; what its links open depends on it. */
    pending: loadDetail && thread === null && !settled,
    projectId: thread?.projectId ?? null,
    worktreePath: thread?.worktreePath ?? null,
    title: thread?.title ?? null,
    /** The provider instance the thread runs on, whose skills its messages name. */
    providerInstanceId: thread?.modelSelection.instanceId ?? null,
    pullRequests: thread?.pullRequests ?? NO_PULL_REQUESTS,
    linkedPullRequest: (thread?.linkedPullRequest ?? null) as ThreadLinkedPullRequest | null,
    branchPullRequest: (shell?.branchPullRequest ?? null) as ThreadLinkedPullRequest | null,
  };
}

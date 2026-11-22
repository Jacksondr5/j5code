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
 * it, the thread itself, loaded rather than guessed from the project root.
 */
export function useSenderThread(ref: ScopedThreadRef | null) {
  const shell = useThreadShell(ref);
  const detail = useEnvironmentThread(
    shell === null ? (ref?.environmentId ?? null) : null,
    shell === null ? (ref?.threadId ?? null) : null,
  );
  const thread = shell ?? Option.getOrNull(detail.data)?.thread ?? null;
  return {
    known: thread !== null,
    projectId: thread?.projectId ?? null,
    worktreePath: thread?.worktreePath ?? null,
    title: thread?.title ?? null,
    pullRequests: thread?.pullRequests ?? NO_PULL_REQUESTS,
    linkedPullRequest: (thread?.linkedPullRequest ?? null) as ThreadLinkedPullRequest | null,
    branchPullRequest: (shell?.branchPullRequest ?? null) as ThreadLinkedPullRequest | null,
  };
}

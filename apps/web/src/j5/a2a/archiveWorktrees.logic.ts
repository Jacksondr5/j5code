import type { CrewArchiveWorktreeEstimate, CrewWorktreeReason } from "@t3tools/contracts/j5";

/** Why a worktree stays, in the words the archive dialog uses. */
export const worktreeReasonLabel: Record<CrewWorktreeReason, string> = {
  uncommitted_changes: "has uncommitted changes",
  unmerged_commits: "has commits that aren't merged",
  shared: "another thread uses it",
  in_use: "a session is open in it",
  unverified: "couldn't be checked",
  failed: "couldn't be removed",
};

/** The estimate split the way the dialog lists it: what goes, and what stays and why. */
export function groupWorktreeEstimates(worktrees: ReadonlyArray<CrewArchiveWorktreeEstimate>) {
  return {
    removed: worktrees.filter((worktree) => worktree.verdict === "remove"),
    kept: worktrees.filter((worktree) => worktree.verdict === "keep"),
  };
}

/** The last folders of a path, which tell worktrees of one project apart. */
export function worktreeShortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== "");
  return parts.slice(-2).join("/");
}

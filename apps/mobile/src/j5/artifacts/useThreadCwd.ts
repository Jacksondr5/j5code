import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { resolvePreferredThreadWorktreePath } from "../../features/terminal/terminalLaunchContext";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentThread } from "../../state/threads";
import { useThreadWorktreePath } from "../../state/use-thread-detail";

/**
 * Resolves a thread's cwd the way the selected thread's does, for a thread that is not the
 * current route's: the shell, or the loaded detail when the shell is missing, picks the project.
 * Upstream removed its copy as unused at v0.1.11; J5's artifact links still need it.
 */
export function useThreadCwd(ref: ScopedThreadRef | null): string | null {
  const shell = useQuietThreadShell(ref);
  const detailState = useEnvironmentThread(
    shell === null ? (ref?.environmentId ?? null) : null,
    shell === null ? (ref?.threadId ?? null) : null,
  );
  const detailThread = Option.getOrNull(detailState.data)?.thread ?? null;
  const detailWorktreePath = useThreadWorktreePath(ref);
  const projectId = shell?.projectId ?? detailThread?.projectId ?? null;
  const project = useProject(
    ref === null || projectId === null ? null : { environmentId: ref.environmentId, projectId },
  );
  return (
    resolvePreferredThreadWorktreePath({
      threadShellWorktreePath: shell?.worktreePath ?? null,
      threadDetailWorktreePath: detailWorktreePath,
    }) ??
    project?.workspaceRoot ??
    null
  );
}

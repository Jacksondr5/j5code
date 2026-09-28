import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo, useRef } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects } from "../../state/entities";
import type { Thread } from "../../types";
import { useSquadronDirectory, type SquadronDirectoryState } from "./SquadronDirectory";
import { selectDraftSquadron } from "./SquadronDraftState";
import {
  buildSquadronPickerEntries,
  resolveCurrentThreadNewThreadDestination,
  startSquadronDraft,
  type SquadronPickerEntry,
} from "./SquadronPicker.logic";
import { useThreadHomes } from "./ThreadHomesClient";

type BranchSource = Pick<Thread, "id" | "environmentId" | "branch" | "worktreePath">;

/**
 * Case 19's `new-thread-on-branch` rule for the header action menu (upstream's
 * `useThreadActionMenu`): the source thread's immutable Registrar home decides
 * the destination, its folder is only launch substrate, and the draft gets SQ1's
 * carrier. Unknown or several homes open the Squadron picker; a missing folder
 * fails closed with a named error. The sidebar row menu applies the same rule.
 */
export function useSquadronNewThreadOnBranch(threadRef: ScopedThreadRef | null) {
  const homes = useThreadHomes(threadRef === null ? [] : [threadRef]);
  const { status, squadrons } = useSquadronDirectory();
  const projects = useProjects();
  const entries = useMemo(
    () => buildSquadronPickerEntries({ squadrons, projects }),
    [projects, squadrons],
  );
  const handleNewThread = useNewThreadHandler();
  // The menu is modal; read the snapshots current when the user picks the action.
  const latest = useRef({ homes, status, entries });
  latest.current = { homes, status, entries };

  return useCallback(
    (thread: BranchSource) => {
      const {
        homes: currentHomes,
        status: directoryStatus,
        entries: pickerEntries,
      } = latest.current;
      const home = currentHomes.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      return startSquadronThreadOnBranch({
        thread,
        home: home?.kind === "known" ? home.squadron.id : null,
        directoryStatus,
        entries: pickerEntries,
        handleNewThread,
      });
    },
    [handleNewThread],
  );
}

/** Shared by the sidebar row menu and the header menu so both doors apply one rule. */
export async function startSquadronThreadOnBranch(input: {
  readonly thread: BranchSource;
  /** The source thread's known immutable Registrar home, or null when unknown/native. */
  readonly home: string | null;
  readonly directoryStatus: SquadronDirectoryState["status"];
  readonly entries: ReadonlyArray<SquadronPickerEntry>;
  readonly handleNewThread: ReturnType<typeof useNewThreadHandler>;
}): Promise<void> {
  const { thread } = input;
  const destination = resolveCurrentThreadNewThreadDestination(
    input.home === null ? null : { environmentId: thread.environmentId, squadronId: input.home },
    input.directoryStatus,
    input.entries,
  );
  if (destination.kind === "picker") {
    openCommandPalette({ open: "new-thread-in" });
    return;
  }
  const result = await settlePromise(() =>
    startSquadronDraft({
      entry: destination.entry,
      handleNewThread: (folder) =>
        input.handleNewThread(scopeProjectRef(folder.environmentId, folder.id), {
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          envMode: thread.worktreePath ? "worktree" : "local",
          startFromOrigin: false,
        }),
      selectDraftSquadron,
    }),
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not create thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  } else if (result.value === null) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Squadron folder unavailable",
        description: "This Squadron needs an available folder before a new thread can start.",
      }),
    );
  }
}

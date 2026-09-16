import { useMemo } from "react";
import { isPlaybookThread } from "@j5/playbook-contracts/sidebar";

/** Playbook steps are grouped under their runs rather than the ordinary thread list. */
export function usePlaybookVisibleThreads<T extends { id: string; environmentId: string }>(
  threads: readonly T[],
): T[] {
  return useMemo(() => threads.filter((thread) => !isPlaybookThread(thread.id)), [threads]);
}

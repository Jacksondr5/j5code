import { useMemo } from "react";
import { isPlaybookThread } from "@j5/playbook-contracts/sidebar";
import { usePrimaryEnvironmentId } from "../../state/environments";

/** Keep secondary-environment threads visible until their playbook API is supported. */
export function usePlaybookVisibleThreads<T extends { id: string; environmentId: string }>(
  threads: readonly T[],
): T[] {
  const primary = usePrimaryEnvironmentId();
  return useMemo(
    () =>
      threads.filter((thread) => thread.environmentId !== primary || !isPlaybookThread(thread.id)),
    [threads, primary],
  );
}

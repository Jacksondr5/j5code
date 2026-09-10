import { useMemo } from "react";
import { isWorkflowThread } from "@j5/workflow-contracts/sidebar";
import { usePrimaryEnvironmentId } from "../../state/environments";

/** Keep secondary-environment threads visible until their workflow API is supported. */
export function useWorkflowVisibleThreads<T extends { id: string; environmentId: string }>(
  threads: readonly T[],
): T[] {
  const primary = usePrimaryEnvironmentId();
  return useMemo(
    () =>
      threads.filter((thread) => thread.environmentId !== primary || !isWorkflowThread(thread.id)),
    [threads, primary],
  );
}

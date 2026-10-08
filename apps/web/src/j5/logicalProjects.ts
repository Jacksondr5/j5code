import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";

/** The slice of upstream's logical project (a sidebar project snapshot) the J5 views need. */
export interface LogicalProjectGroup {
  readonly projectKey: string;
  readonly displayName: string;
  readonly memberProjects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
  }>;
}

/**
 * Resolves a J5 ledger row to upstream's logical project by the project id the row carries.
 * Returns undefined while the project has not loaded or when it is gone, so the caller can fall
 * back to the title the read carries.
 */
export function createLogicalProjectLookup<Group extends LogicalProjectGroup>(
  groups: ReadonlyArray<Group>,
) {
  const groupByProject = new Map<string, Group>();
  for (const group of groups)
    for (const member of group.memberProjects)
      groupByProject.set(`${member.environmentId}\u0000${member.id}`, group);
  return (environmentId: EnvironmentId, projectId: string) =>
    groupByProject.get(`${environmentId}\u0000${projectId}`);
}

/** Upstream's logical projects for the J5 views that read a project-keyed ledger (Fleet, Inbox). */
export function useLogicalProjects() {
  const groups = useSettingsProjectGroups();
  return useMemo(() => createLogicalProjectLookup(groups), [groups]);
}

import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

import {
  buildSidebarProjectPickerEntries,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";

/**
 * Upstream's project picker for a new thread, narrowed to the checkouts the person may start a
 * thread in. A group keeps only those checkouts, so its chosen one, and the one a click in it
 * falls back to, is one that can take a thread; a group with none is left out.
 */
export function startableProjectPicker(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly preferredProjectRef: ScopedProjectRef | null;
  readonly canStartIn: (environmentId: EnvironmentId, projectId: ProjectId) => boolean;
}) {
  const groups = input.groups.flatMap((group): SidebarProjectSnapshot[] => {
    const memberProjects = group.memberProjects.filter((member) =>
      input.canStartIn(member.environmentId, member.id),
    );
    if (memberProjects.length === 0) return [];
    if (memberProjects.length === group.memberProjects.length) return [group];
    return [
      {
        ...group,
        memberProjects,
        memberProjectRefs: group.memberProjectRefs.filter((ref) =>
          input.canStartIn(ref.environmentId, ref.projectId),
        ),
      },
    ];
  });
  const entries = buildSidebarProjectPickerEntries({
    groups,
    preferredProjectRef: input.preferredProjectRef,
  });
  return {
    projects: entries.map(
      ({ group, targetProject }): SidebarProjectGroupMember & { displayName: string } => ({
        ...targetProject,
        displayName: group.displayName,
      }),
    ),
    groupByTargetKey: new Map(
      entries.map(({ group, targetProject }) => [
        `${targetProject.environmentId}:${targetProject.id}`,
        group,
      ]),
    ),
  };
}

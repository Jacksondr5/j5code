import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { ResolvedSettingsScope } from "../components/settings/settingsScope";
import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";

/** Whether one environment's project is inside the settings selection. */
export function isProjectInSettingsScope(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "environment":
      return environmentId === scope.environmentId;
    case "unavailable":
      return false;
    default:
      return scope.members.some(
        (member) => member.environmentId === environmentId && member.id === projectId,
      );
  }
}

/**
 * The project a per-project picker is locked to on one environment: the
 * selection's checkout there when the scope names a project, otherwise null
 * (the picker stays free).
 */
export function lockedSettingsScopeProject(
  scope: ResolvedSettingsScope | undefined,
  environmentId: EnvironmentId,
): SidebarProjectGroupMember | null {
  if (scope?.kind !== "project" && scope?.kind !== "checkout") return null;
  return scope.members.find((member) => member.environmentId === environmentId) ?? null;
}

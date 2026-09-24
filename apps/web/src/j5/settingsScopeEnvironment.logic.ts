import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { ResolvedSettingsScope } from "../components/settings/settingsScope";

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

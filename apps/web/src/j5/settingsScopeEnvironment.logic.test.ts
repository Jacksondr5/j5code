import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSettingsScope } from "../components/settings/settingsScope";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import {
  isProjectInSettingsScope,
  lockedSettingsScopeProject,
} from "./settingsScopeEnvironment.logic";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "Laptop" },
  { environmentId: serverId, label: "Server" },
];

function member(id: string, environmentId: EnvironmentId): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/repos/${id}`,
    physicalProjectKey: `${environmentId}:/repos/${id}`,
    environmentLabel: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

const laptopCheckout = member("t3-laptop", laptopId);
const serverCheckout = member("t3-server", serverId);
const unrelated = member("other", laptopId);
const groups: SidebarProjectSnapshot[] = [
  {
    ...laptopCheckout,
    projectKey: "t3code",
    displayName: "T3 Code",
    memberProjects: [laptopCheckout, serverCheckout],
    memberProjectRefs: [],
    groupedProjectCount: 2,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
  },
];

const inScope = (search: Parameters<typeof resolveSettingsScope>[0]) => {
  const scope = resolveSettingsScope(search, groups, environments);
  return [laptopCheckout, serverCheckout, unrelated]
    .filter((project) => isProjectInSettingsScope(scope, project.environmentId, project.id))
    .map((project) => project.id);
};

describe("isProjectInSettingsScope", () => {
  it("keeps every project when the selection names nothing", () => {
    expect(inScope({})).toEqual(["t3-laptop", "t3-server", "other"]);
  });

  it("keeps an environment's projects when only the environment is named", () => {
    expect(inScope({ machine: laptopId })).toEqual(["t3-laptop", "other"]);
  });

  it("keeps the named project's checkouts, narrowed by a named environment", () => {
    expect(inScope({ project: "t3code" })).toEqual(["t3-laptop", "t3-server"]);
    expect(inScope({ project: "t3code", machine: serverId })).toEqual(["t3-server"]);
  });

  it("keeps nothing for an unavailable selection", () => {
    expect(inScope({ project: "missing" })).toEqual([]);
  });
});

describe("lockedSettingsScopeProject", () => {
  const locked = (
    search: Parameters<typeof resolveSettingsScope>[0],
    environmentId: EnvironmentId,
  ) =>
    lockedSettingsScopeProject(resolveSettingsScope(search, groups, environments), environmentId)
      ?.id ?? null;

  it("leaves the picker free when no project is named", () => {
    expect(locked({}, laptopId)).toBeNull();
    expect(locked({ machine: laptopId }, laptopId)).toBeNull();
    expect(lockedSettingsScopeProject(undefined, laptopId)).toBeNull();
  });

  it("locks to the named project's checkout on the page's environment", () => {
    expect(locked({ project: "t3code" }, laptopId)).toBe("t3-laptop");
    expect(locked({ project: "t3code" }, serverId)).toBe("t3-server");
    expect(locked({ project: "t3code", machine: serverId }, serverId)).toBe("t3-server");
  });

  it("leaves the picker free when the project has no checkout on the environment", () => {
    expect(locked({ project: "t3code", machine: serverId }, laptopId)).toBeNull();
    expect(locked({ project: "missing" }, laptopId)).toBeNull();
  });
});

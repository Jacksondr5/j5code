import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSettingsScope } from "../components/settings/settingsScope";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { isProjectInSettingsScope } from "./settingsScopeEnvironment.logic";

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

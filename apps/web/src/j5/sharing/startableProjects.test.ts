import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import { startableProjectPicker } from "./startableProjects";

const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};

const project = (environmentId: EnvironmentId, id: string, title = "shared-repo"): Project => ({
  id: ProjectId.make(id),
  environmentId,
  title,
  workspaceRoot: `/tmp/${id}`,
  repositoryIdentity: title === "shared-repo" ? repositoryIdentity : null,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
});

// One repository checked out on both servers, shown as one group whose representative is local.
const groups = buildSidebarProjectSnapshots({
  projects: [project(LOCAL, "shared-local"), project(REMOTE, "shared-remote")],
  settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: LOCAL,
  resolveEnvironmentLabel: () => null,
});

const startsOnlyIn =
  (...ids: string[]) =>
  (_environmentId: EnvironmentId, projectId: ProjectId) =>
    ids.includes(projectId);

describe("the projects offered a new thread", () => {
  it("offers a group by a checkout that can take a thread when its usual one cannot", () => {
    const picker = startableProjectPicker({
      groups,
      preferredProjectRef: null,
      canStartIn: startsOnlyIn("shared-remote"),
    });
    expect(picker.projects.map((entry) => entry.id)).toEqual(["shared-remote"]);
    expect(picker.projects[0]?.displayName).toBe(groups[0]?.displayName);
  });

  it("keeps a click in the group from falling back to a checkout that cannot take a thread", () => {
    const picker = startableProjectPicker({
      groups,
      preferredProjectRef: { environmentId: LOCAL, projectId: ProjectId.make("shared-local") },
      canStartIn: startsOnlyIn("shared-remote"),
    });
    const group = picker.groupByTargetKey.get(`${REMOTE}:shared-remote`);
    expect(group?.memberProjectRefs).toEqual([
      { environmentId: REMOTE, projectId: "shared-remote" },
    ]);
  });

  it("leaves out a group none of whose checkouts can take a thread", () => {
    expect(
      startableProjectPicker({ groups, preferredProjectRef: null, canStartIn: startsOnlyIn() })
        .projects,
    ).toEqual([]);
  });

  it("leaves a group upstream's when every checkout can take a thread", () => {
    const picker = startableProjectPicker({
      groups,
      preferredProjectRef: { environmentId: REMOTE, projectId: ProjectId.make("shared-remote") },
      canStartIn: startsOnlyIn("shared-local", "shared-remote"),
    });
    expect(picker.projects.map((entry) => entry.id)).toEqual(["shared-remote"]);
    expect(picker.groupByTargetKey.get(`${REMOTE}:shared-remote`)).toBe(groups[0]);
  });
});

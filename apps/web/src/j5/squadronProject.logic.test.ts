import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createSquadronProjectLookup } from "./squadronProject.logic";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const app = ProjectId.make("project:app");
const appOnServer = ProjectId.make("project:app-remote");
const docs = ProjectId.make("project:docs");

describe("createSquadronProjectLookup", () => {
  const appGroup = {
    projectKey: "repo:app",
    displayName: "App",
    memberProjects: [
      { environmentId: laptop, id: app },
      { environmentId: server, id: appOnServer },
    ],
  };
  const docsGroup = {
    projectKey: "laptop:docs",
    displayName: "Docs",
    memberProjects: [{ environmentId: laptop, id: docs }],
  };
  const lookup = createSquadronProjectLookup({
    groups: [appGroup, docsGroup],
    squadrons: [
      { environmentId: laptop, squadron: { id: "squadron:one" }, projectIds: [app] },
      { environmentId: server, squadron: { id: "squadron:one" }, projectIds: [appOnServer] },
      { environmentId: laptop, squadron: { id: "squadron:gone" }, projectIds: [] },
    ],
  });

  it("maps a project on either machine to its one logical project", () => {
    expect(lookup.ofProject(laptop, app)).toBe(appGroup);
    expect(lookup.ofProject(server, appOnServer)).toBe(appGroup);
    expect(lookup.ofProject(laptop, docs)).toBe(docsGroup);
  });

  it("does not match a project id on a machine that does not hold it", () => {
    expect(lookup.ofProject(server, app)).toBeUndefined();
  });

  it("reaches a Squadron's project per machine, since Squadron ids are per ledger", () => {
    expect(lookup.ofSquadron(laptop, "squadron:one")).toBe(appGroup);
    expect(lookup.ofSquadron(server, "squadron:one")).toBe(appGroup);
  });

  it("leaves an unknown Squadron, or one with no project, unresolved", () => {
    expect(lookup.ofSquadron(laptop, "squadron:missing")).toBeUndefined();
    expect(lookup.ofSquadron(laptop, "squadron:gone")).toBeUndefined();
  });
});

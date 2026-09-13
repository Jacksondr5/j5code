import { describe, expect, it } from "vite-plus/test";

import { formatSquadronFolder, resolveSquadronCreationState } from "./SquadronCreate.logic";

describe("formatSquadronFolder", () => {
  it("keeps the selected folder human-readable instead of exposing its durable project id", () => {
    expect(
      formatSquadronFolder({ title: "J5 Code", workspaceRoot: "/Users/jackson/repos/j5code" }),
    ).toBe("J5 Code — /Users/jackson/repos/j5code");
  });
});

describe("resolveSquadronCreationState", () => {
  it("requires an explicit name and existing folder instead of inventing either", () => {
    expect(
      resolveSquadronCreationState({
        name: " ",
        hasSelectedProject: true,
        environmentAvailable: true,
        canOperate: true,
      }),
    ).toMatchObject({ kind: "missing-name" });
    expect(
      resolveSquadronCreationState({
        name: "Alpha",
        hasSelectedProject: false,
        environmentAvailable: false,
        canOperate: true,
      }),
    ).toMatchObject({ kind: "missing-project" });
  });

  it("refuses a folder whose environment is unavailable", () => {
    expect(
      resolveSquadronCreationState({
        name: "Alpha",
        hasSelectedProject: true,
        environmentAvailable: false,
        canOperate: true,
      }),
    ).toMatchObject({ kind: "environment-unavailable" });
  });

  it("permits an explicit name and selected folder on any available environment", () => {
    expect(
      resolveSquadronCreationState({
        name: "Alpha",
        hasSelectedProject: true,
        environmentAvailable: true,
        canOperate: true,
      }),
    ).toEqual({ kind: "ready" });
  });
});

it("refuses creation through a read-only connection", () => {
  expect(
    resolveSquadronCreationState({
      name: "Remote",
      hasSelectedProject: true,
      environmentAvailable: true,
      canOperate: false,
    }),
  ).toMatchObject({ kind: "read-only-environment" });
});

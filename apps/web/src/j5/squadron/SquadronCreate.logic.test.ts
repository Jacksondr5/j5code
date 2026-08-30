import { describe, expect, it } from "vite-plus/test";

import {
  PRIMARY_ENVIRONMENT_CREATION_REASON,
  resolveSquadronCreationState,
} from "./SquadronCreate.logic";

describe("resolveSquadronCreationState", () => {
  it("requires an explicit name and existing folder instead of inventing either", () => {
    expect(
      resolveSquadronCreationState({ name: " ", hasSelectedProject: true, isPrimaryProject: true }),
    ).toMatchObject({ kind: "missing-name" });
    expect(
      resolveSquadronCreationState({
        name: "Alpha",
        hasSelectedProject: false,
        isPrimaryProject: false,
      }),
    ).toMatchObject({ kind: "missing-project" });
  });

  it("refuses a non-primary folder with the v0 return condition", () => {
    expect(
      resolveSquadronCreationState({
        name: "Alpha",
        hasSelectedProject: true,
        isPrimaryProject: false,
      }),
    ).toEqual({ kind: "non-primary-project", message: PRIMARY_ENVIRONMENT_CREATION_REASON });
  });

  it("permits only an explicit name and selected primary folder", () => {
    expect(
      resolveSquadronCreationState({
        name: "Alpha",
        hasSelectedProject: true,
        isPrimaryProject: true,
      }),
    ).toEqual({ kind: "ready" });
  });
});

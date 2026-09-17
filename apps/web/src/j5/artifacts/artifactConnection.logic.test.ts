import { describe, expect, it } from "vite-plus/test";

import { canFetchArtifacts } from "./artifactConnection.logic";

describe("canFetchArtifacts", () => {
  it("waits for the selected environment connection before fetching", () => {
    const selected = { environmentId: "environment:remote", projectId: "project:remote" };
    expect(canFetchArtifacts({ ...selected, connected: false })).toBe(false);
    expect(canFetchArtifacts({ ...selected, connected: true })).toBe(true);
  });

  it("does not fetch without a complete project selection", () => {
    expect(canFetchArtifacts({ environmentId: null, projectId: "project", connected: true })).toBe(
      false,
    );
    expect(
      canFetchArtifacts({ environmentId: "environment", projectId: null, connected: true }),
    ).toBe(false);
  });
});

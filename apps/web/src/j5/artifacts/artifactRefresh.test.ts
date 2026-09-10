import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextArtifactRefreshGeneration } from "./artifactRefresh";

describe("artifact refresh generation", () => {
  it("refreshes when a watcher subscription emits its reconnect baseline", () => {
    expect(
      nextArtifactRefreshGeneration(4, {
        projectId: ProjectId.make("project:artifact-refresh"),
        revision: 0,
      }),
    ).toBe(5);
  });

  it("does not refresh before the watcher has emitted", () => {
    expect(nextArtifactRefreshGeneration(4, null)).toBe(4);
  });
});

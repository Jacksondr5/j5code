import { describe, expect, it } from "vite-plus/test";

import { artifactPathFromWorkspaceRelativePath } from "./artifactPath";

describe("artifactPathFromWorkspaceRelativePath", () => {
  it.each([
    ["artifacts/plan.md", "plan.md"],
    ["./artifacts/diagrams/system.html", "diagrams/system.html"],
    [String.raw`artifacts\notes\decisions.md`, "notes/decisions.md"],
  ])("recognizes artifact paths: %s", (workspacePath, artifactPath) => {
    expect(artifactPathFromWorkspaceRelativePath(workspacePath)).toBe(artifactPath);
  });

  it.each([null, "artifacts", "src/artifacts/plan.md", "artifacts-other/plan.md"])(
    "rejects non-artifact paths: %s",
    (workspacePath) => {
      expect(artifactPathFromWorkspaceRelativePath(workspacePath)).toBeNull();
    },
  );
});

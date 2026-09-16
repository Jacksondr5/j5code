import type { ArtifactEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { artifactSelectionAfterTrash } from "./artifactTrash.logic";

const entry = (path: string): ArtifactEntry => ({ path, byteLength: 1, modifiedAt: null });

describe("artifactSelectionAfterTrash", () => {
  it("selects the next artifact when one is trashed", () => {
    expect(
      artifactSelectionAfterTrash([entry("a.md"), entry("b.md"), entry("c.md")], "b.md"),
    ).toMatchObject({
      entries: [entry("a.md"), entry("c.md")],
      selectedPath: "c.md",
    });
  });

  it("falls back to the previous artifact and then to no selection", () => {
    expect(artifactSelectionAfterTrash([entry("a.md"), entry("b.md")], "b.md").selectedPath).toBe(
      "a.md",
    );
    expect(artifactSelectionAfterTrash([entry("a.md")], "a.md").selectedPath).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import { artifactPreviewRevision } from "./artifactPreview.logic";

describe("artifact preview revision", () => {
  const plan = { modifiedAt: "2026-09-16T10:00:00.000Z", byteLength: 1200 };

  it("stays put when the list refreshes with the selected file unchanged", () => {
    expect(artifactPreviewRevision(plan, 0)).toBe(artifactPreviewRevision({ ...plan }, 0));
  });

  it("moves when the selected file's own size or time changes", () => {
    expect(artifactPreviewRevision({ ...plan, byteLength: 1201 }, 0)).not.toBe(
      artifactPreviewRevision(plan, 0),
    );
    expect(
      artifactPreviewRevision({ ...plan, modifiedAt: "2026-09-16T10:00:01.000Z" }, 0),
    ).not.toBe(artifactPreviewRevision(plan, 0));
  });

  it("moves on a manual refresh even when the entry cannot show a change", () => {
    const silent = { modifiedAt: null, byteLength: 1200 };
    expect(artifactPreviewRevision(silent, 0)).toBe(artifactPreviewRevision(silent, 0));
    expect(artifactPreviewRevision(silent, 1)).not.toBe(artifactPreviewRevision(silent, 0));
  });
});

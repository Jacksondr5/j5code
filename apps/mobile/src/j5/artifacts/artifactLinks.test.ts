import { describe, expect, it } from "vite-plus/test";

import { artifactPathForMarkdownLink } from "./artifactLinks";

describe("artifact links in chat", () => {
  const root = "/work/repo";

  it.each([
    ["artifacts/plan.md", "plan.md"],
    ["./artifacts/handoffs/builder.md", "handoffs/builder.md"],
    ["/work/repo/artifacts/diagrams/flow.html", "diagrams/flow.html"],
  ])("opens %s as the artifact %s", (href, path) => {
    expect(artifactPathForMarkdownLink(href, root)).toBe(path);
  });

  it.each(["src/artifacts/plan.md", "README.md", "https://example.com/artifacts/plan.md"])(
    "leaves %s to the workspace or browser",
    (href) => {
      expect(artifactPathForMarkdownLink(href, root)).toBeNull();
    },
  );
});

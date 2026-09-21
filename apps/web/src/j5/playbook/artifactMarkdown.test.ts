import { describe, expect, it } from "vite-plus/test";
import { reviewDocument } from "./artifactMarkdown";
import { isPlaybookThread } from "@j5/playbook-contracts/sidebar";

describe("playbook review documents", () => {
  it("preserves Markdown and exact executable arguments in a reviewable plan", () => {
    const summary = "Use **existing APIs**.\n\n- Keep compatibility";
    const plan = {
      summary,
      steps: ["Add the endpoint", "Verify it"],
      checks: [{ executable: "node", args: ["--test", "a file.test.mjs", "```"] }],
    };
    const before = JSON.stringify(plan);
    const markdown = reviewDocument(plan);
    expect(markdown).toContain(summary);
    expect(markdown).toContain("1. Add the endpoint\n2. Verify it");
    expect(markdown).toContain(
      JSON.stringify(["node", "--test", "a file.test.mjs", "```"], null, 2),
    );
    expect(markdown).toContain("````");
    expect(JSON.stringify(plan)).toBe(before);
    expect(reviewDocument("# A supplied document\n\n**Read this**")).toBe(
      "# A supplied document\n\n**Read this**",
    );
  });
  it("keeps blocking findings and failed check evidence visible", () => {
    expect(
      reviewDocument({
        verdict: "revise",
        findings: [{ blocking: true, description: "Missing rollback" }],
      }),
    ).toContain("### Blocking finding\n\nMissing rollback");
    const markdown = reviewDocument({
      passed: false,
      checks: [{ executable: "node", args: ["test.mjs"], exitCode: 1, output: "assertion failed" }],
    });
    expect(markdown).toContain("Failed (exit 1)");
    expect(markdown).toContain("assertion failed");
  });
  it("recognizes only the reserved playbook thread identity", () => {
    expect(isPlaybookThread(`thread:pb:${"a".repeat(64)}`)).toBe(true);
    expect(isPlaybookThread("playbook:manual-thread")).toBe(false);
    expect(isPlaybookThread("thread:pb:ordinary")).toBe(false);
  });
  it("keeps a 96 KiB diff out of the Markdown projection until its section is expanded", () => {
    const diff = "x".repeat(96 * 1024);
    const markdown = reviewDocument({ summary: "Validated candidate", diff });
    expect(markdown).toBe("Validated candidate");
    expect(markdown.length).toBeLessThan(96);
  });
});

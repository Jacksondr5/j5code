import { describe, expect, it } from "vite-plus/test";
import { reviewDocument } from "./artifactMarkdown";
import { isWorkflowThread } from "@j5/workflow-contracts/sidebar";

describe("workflow review documents", () => {
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
  it("recognizes only the reserved workflow thread identity", () => {
    expect(isWorkflowThread(`thread:wf:${"a".repeat(64)}`)).toBe(true);
    expect(isWorkflowThread("workflow:manual-thread")).toBe(false);
    expect(isWorkflowThread("thread:wf:ordinary")).toBe(false);
  });
});

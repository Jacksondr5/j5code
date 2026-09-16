// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the artifact view with its live-preview contract.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("./ArtifactsPage.tsx", import.meta.url), "utf8");
const chatViewSource = NodeFS.readFileSync(
  new URL("../../components/ChatView.tsx", import.meta.url),
  "utf8",
);

describe("artifact previews", () => {
  // When the body re-reads is decided by artifactPreviewRevision and tested in
  // artifactPreview.logic.test.ts; a source-string assertion here could not tell a double read
  // from a single one.
  it("holds the environment connection itself and waits for it before fetching", () => {
    // Without a subscriber the prepared-connection atom reads as none, so the standalone route
    // failed every list with "The project environment is not connected."
    expect(source).toContain("usePreparedConnection(selectedEnvironmentId)");
    expect(source).toContain("if (!connected) {");
    expect(source).toContain("Connecting to the environment…");
  });

  it("renders HTML in an isolated transparent iframe", () => {
    expect(source).toContain('sandbox=""');
    expect(source).toContain('referrerPolicy="no-referrer"');
    expect(source).toContain("srcDoc={content.content}");
    expect(source).toContain("border-0 bg-transparent");
  });

  it("renders a project-scoped artifact browser in the thread right panel", () => {
    expect(chatViewSource).toContain('renderedRightPanelSurface?.kind === "artifacts"');
    expect(chatViewSource).toContain("<ArtifactsPage");
    expect(chatViewSource).toContain("embedded");
    expect(chatViewSource).toContain("initialPath: renderedRightPanelSurface.selectedPath");
    expect(source).toContain("useState<string | null>(() => initialPath ?? null)");
    expect(source).toContain("grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)]");
  });
});

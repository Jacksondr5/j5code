// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the artifact view with its live-preview contract.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("./ArtifactsPage.tsx", import.meta.url), "utf8");
const chatViewSource = NodeFS.readFileSync(
  new URL("../../components/ChatView.tsx", import.meta.url),
  "utf8",
);

describe("artifact previews", () => {
  it("refreshes the file list and selected content when the artifact watcher emits", () => {
    expect(source).toContain("artifactEnvironment.changes");
    expect(source).toContain("setRefreshGeneration((generation) => generation + 1)");
    expect(source).toContain("[refreshGeneration, selectedEnvironmentId, selectedProjectId]");
    expect(source).toContain(
      "[refreshGeneration, selectedEnvironmentId, selectedPath, selectedProjectId]",
    );
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
    expect(source).toContain("grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)]");
  });
});

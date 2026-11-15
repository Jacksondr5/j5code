import { describe, expect, it } from "vite-plus/test";

import { artifactHtmlLoadAllowed } from "./artifactHtmlPreview.logic";

describe("artifactHtmlLoadAllowed", () => {
  it("loads the artifact and its in-page anchors, and nothing else", () => {
    expect(artifactHtmlLoadAllowed("about:blank")).toBe(true);
    expect(artifactHtmlLoadAllowed("about:blank#results")).toBe(true);
    for (const url of [
      "https://example.com/",
      "http://localhost:4773/api",
      "javascript:alert(1)",
      "data:text/html,<p>hi</p>",
      "file:///etc/hosts",
      "about:blankish",
      "intent://scan/#Intent;scheme=zxing;end",
    ]) {
      expect(artifactHtmlLoadAllowed(url)).toBe(false);
    }
  });
});

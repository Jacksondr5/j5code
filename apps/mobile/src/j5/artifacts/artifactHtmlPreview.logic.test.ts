import { describe, expect, it } from "vite-plus/test";

import { artifactHtmlFrameDocument, artifactHtmlLoadAllowed } from "./artifactHtmlPreview.logic";

describe("artifactHtmlFrameDocument", () => {
  it("holds the whole artifact inside the sandboxed frame's srcdoc", () => {
    const artifact = `<p title="a &quot; b">x</p>"></iframe><script>alert(1)</script><form method="post">`;
    const page = artifactHtmlFrameDocument(artifact);
    const frame = page.match(/<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="([^"]*)">/);
    expect(frame).not.toBeNull();
    expect(page.slice(page.indexOf(frame![0]) + frame![0].length)).toBe("</iframe></body></html>");
    const decoded = frame![1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    expect(decoded).toBe(artifact);
  });
});

describe("artifactHtmlLoadAllowed", () => {
  it("lets the frame load anything, and the top only the page and its anchors", () => {
    for (const url of ["about:srcdoc", "https://example.com/", "about:blank"]) {
      expect(artifactHtmlLoadAllowed({ url, isTopFrame: false })).toBe(true);
    }
    for (const url of ["about:blank", "about:blank#results"]) {
      expect(artifactHtmlLoadAllowed({ url, isTopFrame: true })).toBe(true);
      expect(artifactHtmlLoadAllowed({ url })).toBe(true);
    }
    for (const url of [
      "https://example.com/",
      "http://localhost:4773/api",
      "javascript:alert(1)",
      "data:text/html,<p>hi</p>",
      "file:///etc/hosts",
      "about:blankish",
      "about:srcdoc",
      "intent://scan/#Intent;scheme=zxing;end",
    ]) {
      expect(artifactHtmlLoadAllowed({ url, isTopFrame: true })).toBe(false);
      expect(artifactHtmlLoadAllowed({ url })).toBe(false);
    }
  });
});

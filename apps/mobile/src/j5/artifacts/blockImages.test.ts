import { describe, expect, it } from "vite-plus/test";

import { withBlockImages } from "./blockImages";

describe("withBlockImages", () => {
  it("gives an image that shares a line with text its own paragraph", () => {
    expect(withBlockImages("See [a](a.ts), [b](b.ts) ![pic](docs/pic.png) and more")).toBe(
      "See [a](a.ts), [b](b.ts)\n\n![pic](docs/pic.png)\n\nand more",
    );
  });

  it("leaves an image alone on its line, and text without images", () => {
    const markdown = "Intro\n\n![pic](pic.png)\n\nNo image here.";
    expect(withBlockImages(markdown)).toBe(markdown);
  });

  it("leaves images in code, in a link, or in a fenced block as written", () => {
    const markdown = [
      "Use `![x](y.png)` in text",
      "[![badge](badge.svg)](https://example.com) build",
      "```",
      "text ![pic](pic.png) text",
      "```",
    ].join("\n");
    expect(withBlockImages(markdown)).toBe(markdown);
  });

  it("splits each of two images, keeping a title", () => {
    expect(withBlockImages('![a](a.png) and ![b](b.png "B")')).toBe(
      '![a](a.png)\n\nand\n\n![b](b.png "B")',
    );
  });
});

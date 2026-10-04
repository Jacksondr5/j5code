import { describe, expect, it } from "vite-plus/test";

import { describeJ5CommandResult } from "./j5Command.logic";

const command = "/Users/a/.local/bin/j5";

describe("the notice after installing the j5 command", () => {
  it("names the startup file the app changed", () => {
    expect(
      describeJ5CommandResult({
        outcome: "installed",
        command,
        profile: "/Users/a/.zshrc",
        pathHint: null,
      }).description,
    ).toBe(
      "Linked /Users/a/.local/bin/j5 and added its folder to your PATH in /Users/a/.zshrc. Open a new terminal to use it.",
    );
  });

  it("says which folder to add when no startup file could be edited", () => {
    expect(
      describeJ5CommandResult({
        outcome: "installed",
        command,
        profile: null,
        pathHint: "/Users/a/.local/bin",
      }).description,
    ).toBe("Linked /Users/a/.local/bin/j5. Add /Users/a/.local/bin to your PATH to use it.");
  });

  it("says nothing changed when another install owns the command", () => {
    const notice = describeJ5CommandResult({
      outcome: "kept",
      command,
      profile: null,
      pathHint: null,
    });
    expect(notice.type).toBe("info");
    expect(notice.description).toContain("Nothing was changed");
  });
});

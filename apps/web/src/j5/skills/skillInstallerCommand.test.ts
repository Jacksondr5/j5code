import { describe, expect, it } from "vite-plus/test";

import { skillInstallerCommand } from "./skillInstallerCommand";

describe("skill installer command", () => {
  it("quotes posix paths with single quotes", () => {
    expect(skillInstallerCommand("/path/to/agent-skills", "darwin")).toBe(
      "node '/path/to/agent-skills/install-skills.mjs'",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(skillInstallerCommand("/a'b", "Linux")).toBe(`node '/a'\\''b/install-skills.mjs'`);
  });

  it("uses double quotes on windows", () => {
    expect(skillInstallerCommand("C:\\skills", "windows")).toBe(
      'node "C:\\skills/install-skills.mjs"',
    );
  });

  it("trims slashes and rejects blank folders", () => {
    expect(skillInstallerCommand("/path/to/agent-skills///  ", "darwin")).toBe(
      "node '/path/to/agent-skills/install-skills.mjs'",
    );
    expect(skillInstallerCommand("   ", "darwin")).toBeNull();
  });
});

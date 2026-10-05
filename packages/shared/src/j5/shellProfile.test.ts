import { describe, expect, it } from "vite-plus/test";

import { J5_PATH_MARKER, j5PathEntry } from "./shellProfile.ts";

const entry = (overrides: Partial<Parameters<typeof j5PathEntry>[0]>) =>
  j5PathEntry({
    shell: "/bin/zsh",
    platform: "darwin",
    home: "/Users/a",
    binDir: "/Users/a/.local/bin",
    exists: () => false,
    ...overrides,
  });

// These mirror the choices in scripts/install.sh, which install.test.ts pins.
describe("the PATH line for a shell", () => {
  it("appends the directory for zsh, honouring ZDOTDIR", () => {
    expect(entry({ zdotdir: "/Users/a/.zsh" })).toEqual({
      profile: "/Users/a/.zsh/.zshrc",
      line: `export PATH="$PATH:/Users/a/.local/bin" ${J5_PATH_MARKER}`,
    });
  });

  it("uses the login file macOS bash already has, so .profile isn't hidden", () => {
    const profile = (existing: ReadonlyArray<string>) =>
      entry({ shell: "/bin/bash", exists: (file) => existing.includes(file) })?.profile;
    expect(profile(["/Users/a/.profile"])).toBe("/Users/a/.profile");
    expect(profile(["/Users/a/.bash_login", "/Users/a/.profile"])).toBe("/Users/a/.bash_login");
    expect(profile([])).toBe("/Users/a/.bash_profile");
    expect(entry({ shell: "/bin/bash", platform: "linux", home: "/home/a" })?.profile).toBe(
      "/home/a/.bashrc",
    );
  });

  it("writes fish's line under XDG_CONFIG_HOME, scoped to the shell's PATH", () => {
    expect(entry({ shell: "/opt/homebrew/bin/fish", xdgConfigHome: "/Users/a/xdg" })).toEqual({
      profile: "/Users/a/xdg/fish/config.fish",
      line: `fish_add_path --path --append "/Users/a/.local/bin" ${J5_PATH_MARKER}`,
    });
  });

  it("has no line for another shell or a directory the shell would expand", () => {
    expect(entry({ shell: "/bin/tcsh" })).toBeUndefined();
    expect(entry({ binDir: "/Users/a/cli$tools" })).toBeUndefined();
  });
});

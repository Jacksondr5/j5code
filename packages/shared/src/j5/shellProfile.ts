/**
 * The line J5 adds to a shell's startup file so `j5` resolves in new terminals
 * (#397). `scripts/install.sh` writes the same marker; keep the two in step.
 * `j5 uninstall` removes every line that ends with it.
 */
export const J5_PATH_MARKER = "# Added by J5 Code; `j5 uninstall` removes this line.";

/** Startup files an installer may have added the line to (POSIX shells only). */
export function shellProfilePaths(input: {
  readonly home: string;
  readonly zdotdir?: string | undefined;
  readonly xdgConfigHome?: string | undefined;
}): ReadonlyArray<string> {
  return [
    `${input.zdotdir || input.home}/.zshrc`,
    `${input.home}/.bashrc`,
    `${input.home}/.bash_profile`,
    `${input.home}/.bash_login`,
    `${input.home}/.profile`,
    `${input.xdgConfigHome || `${input.home}/.config`}/fish/config.fish`,
  ];
}

/**
 * The startup file a shell reads and the line that puts `binDir` last on its
 * PATH, as `scripts/install.sh` chooses them; keep the two in step. `exists`
 * answers for macOS bash, whose login shells read only the first of
 * `.bash_profile`, `.bash_login` and `.profile` that exists. Undefined when
 * J5 doesn't edit that shell, or when the shell would expand or split
 * `binDir` inside the line's double quotes.
 */
export function j5PathEntry(input: {
  readonly shell: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly zdotdir?: string | undefined;
  readonly xdgConfigHome?: string | undefined;
  readonly binDir: string;
  readonly exists: (file: string) => boolean;
}): { readonly profile: string; readonly line: string } | undefined {
  if (/["$`\\]/.test(input.binDir)) return undefined;
  const exportLine = `export PATH="$PATH:${input.binDir}" ${J5_PATH_MARKER}`;
  switch (input.shell?.split("/").pop()) {
    case "zsh":
      return { profile: `${input.zdotdir || input.home}/.zshrc`, line: exportLine };
    case "bash": {
      if (input.platform !== "darwin")
        return { profile: `${input.home}/.bashrc`, line: exportLine };
      const loginFiles = [".bash_profile", ".bash_login", ".profile"].map(
        (name) => `${input.home}/${name}`,
      );
      return { profile: loginFiles.find(input.exists) ?? loginFiles[0]!, line: exportLine };
    }
    case "fish":
      return {
        profile: `${input.xdgConfigHome || `${input.home}/.config`}/fish/config.fish`,
        // --path changes only this shell's PATH, so deleting the line undoes it.
        line: `fish_add_path --path --append "${input.binDir}" ${J5_PATH_MARKER}`,
      };
    default:
      return undefined;
  }
}

export function hasJ5PathLine(contents: string): boolean {
  return contents.split("\n").some((line) => line.endsWith(J5_PATH_MARKER));
}

export function withoutJ5PathLines(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => !line.endsWith(J5_PATH_MARKER))
    .join("\n");
}

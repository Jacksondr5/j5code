import type { DesktopJ5CommandResult } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  bashLoginFiles,
  J5_PATH_MARKER,
  j5PathEntry,
  shellProfilePaths,
} from "@t3tools/shared/j5/shellProfile";
import { readEnvironmentFromLoginShell } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export class DesktopJ5CommandError extends Schema.TaggedError<DesktopJ5CommandError>()(
  "DesktopJ5CommandError",
  { script: Schema.String },
) {
  override get message(): string {
    return `J5 Code's own j5 script is missing at ${this.script}. Restart J5 Code and try again.`;
  }
}

/**
 * zsh's ZDOTDIR, which decides where `.zshrc` lives. The app is usually
 * launched from Finder and doesn't inherit it, so it is asked of the login
 * shell when the command runs.
 */
export const LoginShellZdotdir = Context.Reference<(shell: string) => string | undefined>(
  "@j5/desktop/LoginShellZdotdir",
  {
    defaultValue: () => (shell) => {
      try {
        return readEnvironmentFromLoginShell(shell, ["ZDOTDIR"])["ZDOTDIR"];
      } catch {
        return undefined;
      }
    },
  },
);

// Profiles needn't be UTF-8. Reading each byte as one latin1 character keeps
// every byte through an edit; J5's line and marker are ASCII.
const asBytes = (contents: Uint8Array) => Buffer.from(contents).toString("latin1");

const optionOnNotFound = <A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

/** Where the command goes and what it links to: the app's script in the J5 home. */
const commandContext = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const processEnvironment = yield* HostProcessEnvironment;
  const { path, homeDirectory: home } = environment;
  const binDir = path.join(home, ".local", "bin");
  const shell = processEnvironment["SHELL"];
  const zdotdir =
    processEnvironment["ZDOTDIR"] ??
    (shell?.split("/").pop() === "zsh" ? (yield* LoginShellZdotdir)(shell) : undefined);
  return {
    supported: environment.isPackaged && environment.platform === "darwin",
    home,
    binDir,
    command: path.join(binDir, "j5"),
    script: path.join(environment.baseDir, "bin", "j5"),
    shell,
    zdotdir,
    xdgConfigHome: processEnvironment["XDG_CONFIG_HOME"],
    // The process PATH was hydrated from the login shell at startup.
    onPath: (processEnvironment["PATH"] ?? "").split(":").includes(binDir),
  };
});

/**
 * Installs `j5` for the person's own terminal, when they ask (#441): links
 * `~/.local/bin/j5` to the app's script and, if `~/.local/bin` isn't on their
 * PATH, appends the installer's marked line to their shell's startup file. A
 * `j5` that is already there from something else, such as a command-line
 * install, is left alone. The result says what changed so the app can tell
 * them.
 */
export const installJ5Command = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* commandContext;
  const { home, binDir, command, script } = context;
  const result = (
    outcome: DesktopJ5CommandResult["outcome"],
    changes?: { readonly profile?: string; readonly pathHint?: string },
  ): DesktopJ5CommandResult => ({
    outcome,
    command,
    profile: changes?.profile ?? null,
    pathHint: changes?.pathHint ?? null,
  });
  if (!context.supported) return result("unsupported");

  const target = yield* fs.readLink(command).pipe(Effect.option);
  const ours = Option.isSome(target) && target.value === script;
  if (!ours && (Option.isSome(target) || (yield* fs.exists(command)))) return result("kept");
  // The app writes the script at every launch; without it the link would be dead.
  if (!(yield* fs.exists(script))) return yield* new DesktopJ5CommandError({ script });
  if (!ours) {
    yield* fs.makeDirectory(binDir, { recursive: true });
    yield* fs.symlink(script, command);
  }

  if (context.onPath) return result("installed");
  const loginFiles = new Set<string>();
  for (const file of bashLoginFiles(home)) {
    if (yield* fs.exists(file)) loginFiles.add(file);
  }
  const entry = j5PathEntry({
    shell: context.shell,
    platform: environment.platform,
    home,
    zdotdir: context.zdotdir,
    xdgConfigHome: context.xdgConfigHome,
    binDir,
    exists: (file) => loginFiles.has(file),
  });
  if (entry === undefined) return result("installed", { pathHint: binDir });
  // Append rather than rewrite, so nothing else in the profile is touched. A
  // profile that can't be read or written gets the hint, like the installer.
  const appended = yield* Effect.gen(function* () {
    const existing = yield* optionOnNotFound(fs.readFile(entry.profile)).pipe(
      Effect.map(Option.match({ onNone: () => "", onSome: asBytes })),
    );
    // This exact line: a marked line for some other directory isn't ours.
    if (existing.split("\n").includes(entry.line)) return true;
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    yield* fs.makeDirectory(environment.path.dirname(entry.profile), { recursive: true });
    yield* fs.writeFileString(entry.profile, `${separator}${entry.line}\n`, { flag: "a" });
    return true;
  }).pipe(Effect.orElseSucceed(() => false));
  return appended
    ? result("installed", { profile: entry.profile })
    : result("installed", { pathHint: binDir });
});

/**
 * Removes what `installJ5Command` added: J5's marked PATH line for
 * `~/.local/bin` from the shell startup files, then the link, when it is still
 * the app's. A `j5` from something else is left alone, with the line that
 * finds it. The link goes last, so a profile that can't be edited leaves a
 * retry something to act on.
 */
export const uninstallJ5Command = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const context = yield* commandContext;
  const { home, binDir, command, script } = context;
  const result = (
    outcome: DesktopJ5CommandResult["outcome"],
    profile: string | null = null,
  ): DesktopJ5CommandResult => ({ outcome, command, profile, pathHint: null });
  if (!context.supported) return result("unsupported");

  const target = yield* fs.readLink(command).pipe(Effect.option);
  if (Option.isNone(target) || target.value !== script) return result("nothing");

  // Only the line for this directory; a command-line install into another
  // directory wrote its own marked line and still needs it.
  const isOurLine = (line: string) => line.endsWith(J5_PATH_MARKER) && line.includes(binDir);
  let edited: string | null = null;
  const profiles = shellProfilePaths({
    home,
    zdotdir: context.zdotdir,
    xdgConfigHome: context.xdgConfigHome,
  });
  for (const profile of profiles) {
    const contents = yield* optionOnNotFound(fs.readFile(profile));
    if (Option.isNone(contents)) continue;
    const lines = asBytes(contents.value).split("\n");
    if (!lines.some(isOurLine)) continue;
    yield* fs.writeFile(
      profile,
      Buffer.from(lines.filter((line) => !isOurLine(line)).join("\n"), "latin1"),
    );
    edited ??= profile;
  }
  yield* fs.remove(command, { force: true });
  return result("removed", edited);
});

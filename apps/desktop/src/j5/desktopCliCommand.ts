import type { DesktopJ5CommandResult } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  hasJ5PathLine,
  j5PathEntry,
  shellProfilePaths,
  withoutJ5PathLines,
} from "@t3tools/shared/j5/shellProfile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

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
const commandPaths = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const { path, homeDirectory: home } = environment;
  const binDir = path.join(home, ".local", "bin");
  return {
    supported: environment.isPackaged && environment.platform === "darwin",
    home,
    binDir,
    command: path.join(binDir, "j5"),
    script: path.join(environment.baseDir, "bin", "j5"),
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
  const processEnvironment = yield* HostProcessEnvironment;
  const { supported, home, binDir, command, script } = yield* commandPaths;
  const result = (
    outcome: DesktopJ5CommandResult["outcome"],
    changes?: { readonly profile?: string; readonly pathHint?: string },
  ): DesktopJ5CommandResult => ({
    outcome,
    command,
    profile: changes?.profile ?? null,
    pathHint: changes?.pathHint ?? null,
  });
  if (!supported) return result("unsupported");

  const target = yield* fs.readLink(command).pipe(Effect.option);
  const ours = Option.isSome(target) && target.value === script;
  if (!ours) {
    if (Option.isSome(target) || (yield* fs.exists(command))) return result("kept");
    yield* fs.makeDirectory(binDir, { recursive: true });
    yield* fs.symlink(script, command);
  }

  // The process PATH was hydrated from the login shell at startup.
  if ((processEnvironment["PATH"] ?? "").split(":").includes(binDir)) return result("installed");
  const loginFiles = new Set<string>();
  for (const name of [".bash_profile", ".bash_login", ".profile"]) {
    const file = environment.path.join(home, name);
    if (yield* fs.exists(file)) loginFiles.add(file);
  }
  const entry = j5PathEntry({
    shell: processEnvironment["SHELL"],
    platform: environment.platform,
    home,
    zdotdir: processEnvironment["ZDOTDIR"],
    xdgConfigHome: processEnvironment["XDG_CONFIG_HOME"],
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
    if (hasJ5PathLine(existing)) return true;
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
 * Removes what `installJ5Command` added: the link, when it is still the app's,
 * and J5's marked PATH line from the shell startup files. A `j5` from
 * something else is left alone, with the line that finds it.
 */
export const uninstallJ5Command = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processEnvironment = yield* HostProcessEnvironment;
  const { supported, home, command, script } = yield* commandPaths;
  const result = (
    outcome: DesktopJ5CommandResult["outcome"],
    profile: string | null = null,
  ): DesktopJ5CommandResult => ({ outcome, command, profile, pathHint: null });
  if (!supported) return result("unsupported");

  const target = yield* fs.readLink(command).pipe(Effect.option);
  if (Option.isNone(target) || target.value !== script) return result("nothing");
  yield* fs.remove(command, { force: true });

  let edited: string | null = null;
  const profiles = shellProfilePaths({
    home,
    zdotdir: processEnvironment["ZDOTDIR"],
    xdgConfigHome: processEnvironment["XDG_CONFIG_HOME"],
  });
  for (const profile of profiles) {
    const contents = yield* optionOnNotFound(fs.readFile(profile));
    if (Option.isNone(contents) || !hasJ5PathLine(asBytes(contents.value))) continue;
    yield* fs.writeFile(
      profile,
      Buffer.from(withoutJ5PathLines(asBytes(contents.value)), "latin1"),
    );
    edited ??= profile;
  }
  return result("removed", edited);
});

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  hasJ5PathLine,
  shellProfilePaths,
  withoutJ5PathLines,
} from "@t3tools/shared/j5/shellProfile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { launcherOwnsVersionsDir } from "../../cli/update.ts";
import { pinnedRuntimeVersionsDir } from "../../cloud/pinnedRuntime.ts";

// Profiles needn't be UTF-8. Reading each byte as one latin1 character keeps
// every byte through the edit; the marker itself is ASCII.
const asBytes = (contents: Uint8Array) => Buffer.from(contents).toString("latin1");

/**
 * What `j5 uninstall` removes from the person's shell setup along with a home:
 * the installer's `~/.local/bin/j5` link and the PATH line that finds it. Both
 * go when that link points into this home's runtime, however uninstall was
 * started, or when no `j5` is there at all (an orphaned line). A `j5` that
 * belongs to something else, such as another home while an agent uninstalls a
 * scratch one, is left alone with its line. A startup file that exists but
 * can't be read fails the uninstall rather than being skipped.
 */
export const planShellCleanup = Effect.fn("j5.cli.plan_shell_cleanup")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const home = environment["HOME"];
  const nothing = { profiles: [] as Array<string>, installerLink: undefined as string | undefined };
  if ((yield* HostProcessPlatform) === "win32" || !home) return nothing;

  const command = path.join(home, ".local/bin/j5");
  const target = yield* fs.readLink(command).pipe(Effect.option);
  const owned =
    Option.isSome(target) &&
    launcherOwnsVersionsDir(
      path,
      pinnedRuntimeVersionsDir(path, baseDir),
      path.resolve(path.dirname(command), target.value),
    );
  if (!owned && (Option.isSome(target) || (yield* fs.exists(command)))) return nothing;

  const profiles: Array<string> = [];
  const files = shellProfilePaths({
    home,
    zdotdir: environment["ZDOTDIR"],
    xdgConfigHome: environment["XDG_CONFIG_HOME"],
  });
  for (const file of files) {
    const contents = yield* fs.readFile(file).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<Uint8Array>())
            : Effect.fail(error),
      }),
    );
    if (Option.isSome(contents) && hasJ5PathLine(asBytes(contents.value))) profiles.push(file);
  }
  return { profiles, installerLink: owned ? command : undefined };
});

/** Removes J5's PATH line from each file, leaving every other byte as it was. */
export const removeJ5PathLines = Effect.fn("j5.cli.remove_path_lines")(function* (
  files: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of files) {
    const contents = asBytes(yield* fs.readFile(file));
    yield* fs.writeFile(file, Buffer.from(withoutJ5PathLines(contents), "latin1"));
  }
});

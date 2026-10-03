import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { launcherOwnsVersionsDir, repointLauncher } from "../../cli/update.ts";
import { pinnedRuntimeVersionsDir } from "../../cloud/pinnedRuntime.ts";

/**
 * Points the `j5` command at the running executable. Called once a background
 * service's server is the committed version, so an in-app update moves the
 * command along with the service (#398). Only the installer's default link
 * (`$T3CODE_INSTALL_BIN_DIR/j5`, else `~/.local/bin/j5`) is considered, and
 * only when it already points into this home's runtime tree; anything else is
 * not ours to touch. Returns the link path when it was repointed.
 */
export const repointCliLauncherToSelf = Effect.fn("j5.cli.repoint_launcher_to_self")(function* (
  baseDir: string,
) {
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const executable = yield* HostProcessExecutablePath;
  const versionsDir = pinnedRuntimeVersionsDir(path, baseDir);
  if (
    !(yield* HostProcessIsExecutable) ||
    (yield* HostProcessPlatform) === "win32" ||
    !launcherOwnsVersionsDir(path, versionsDir, executable)
  ) {
    return Option.none<string>();
  }
  const binDir =
    environment["T3CODE_INSTALL_BIN_DIR"] ??
    (environment["HOME"] ? path.join(environment["HOME"], ".local/bin") : undefined);
  if (binDir === undefined) return Option.none<string>();
  return yield* repointLauncher({
    launchedAs: path.join(binDir, "j5"),
    versionsDir,
    targetEntryPath: executable,
  });
});

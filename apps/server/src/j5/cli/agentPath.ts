import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { mergePathEntries } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/**
 * Makes this server's own `j5` reachable from the agents and terminals it
 * starts, which inherit its PATH (#397). Runs after the PATH is hydrated from
 * the login shell. The executable's directory goes last, so a `j5` already on
 * the person's PATH still wins, and the archive's transition `t3` link never
 * shadows an installed T3 Code. Only the release executable does this; a
 * server run from source or by the desktop app has no `j5` beside it.
 */
export const appendOwnCliToPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const executable = yield* HostProcessExecutablePath;
  if (!(yield* HostProcessIsExecutable)) return;
  if (path.basename(executable) !== (platform === "win32" ? "j5.exe" : "j5")) return;
  const merged = mergePathEntries(environment["PATH"], path.dirname(executable), platform);
  if (merged !== undefined) environment["PATH"] = merged;
});

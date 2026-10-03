import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { mergePathEntries } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The directory in a J5 home that holds only `j5`, for the server's agents. */
export const agentCliDirectory = (path: Path.Path, baseDir: string) => path.join(baseDir, "bin");

/**
 * Lets the agents and terminals this server starts run its own `j5` (#397).
 * They inherit the server's PATH, so after the PATH is hydrated from the login
 * shell the server puts `<home>/bin` first on it and points `<home>/bin/j5` at
 * its own executable. That directory holds nothing else, so agents always get
 * the CLI of the server running them and nothing else on PATH is shadowed.
 *
 * Only the release executable does this. The desktop app writes its own script
 * to the same place before it starts its server, and a server run from source
 * has no `j5` to offer.
 */
export const exposeOwnCliToAgents = Effect.fn("j5.cli.expose_own_cli_to_agents")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const executable = yield* HostProcessExecutablePath;
  if (!(yield* HostProcessIsExecutable) || platform === "win32") return;

  const directory = agentCliDirectory(path, baseDir);
  const command = path.join(directory, "j5");
  const merged = mergePathEntries(directory, environment["PATH"], platform);
  if (merged !== undefined) environment["PATH"] = merged;
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.remove(command, { force: true });
  yield* fs.symlink(executable, command);
});

import { desktopCliScript } from "@t3tools/shared/j5/desktopCli";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

/**
 * Lets the agents and terminals the packaged macOS app runs call `j5` (#397).
 * Before the backend starts, the app writes a script that runs its bundled CLI
 * to `<home>/bin/j5`. The backend finds it there and puts `<home>/bin` first
 * on the PATH its agents inherit (`apps/server/src/j5/cli/agentPath.ts`), the
 * same directory a release server uses for its own `j5`.
 *
 * Nothing outside the J5 home is touched: the person's PATH and shell startup
 * files change only when they ask for the command. Skipped in development and
 * off macOS, where J5 ships no desktop build.
 */
export const exposeDesktopCli = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const executable = yield* HostProcessExecutablePath;
  const { path } = environment;
  if (!environment.isPackaged || environment.platform !== "darwin") return;

  const directory = path.join(environment.baseDir, "bin");
  const command = path.join(directory, "j5");
  yield* fs.makeDirectory(directory, { recursive: true });
  // Remove first: a server install may have left a link here, and writing
  // through it would overwrite that server's executable.
  yield* fs.remove(command, { force: true });
  yield* fs.writeFileString(
    command,
    desktopCliScript({ executable, entry: environment.backendEntryPath }),
    { mode: 0o755 },
  );
  yield* fs.chmod(command, 0o755);
});

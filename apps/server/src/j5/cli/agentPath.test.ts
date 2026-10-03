import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import { exposeOwnCliToAgents } from "./agentPath.ts";

// A home with two installed versions; returns each version's executable.
const makeHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "j5-agent-path-" });
  const executables = ["1.0.0", "2.0.0"].map((version) =>
    path.join(baseDir, "runtime/versions", version, "j5"),
  );
  for (const executable of executables) {
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
    yield* fs.writeFileString(executable, "");
  }
  return { baseDir, previous: executables[0]!, running: executables[1]! };
});

const startServer = (input: {
  readonly baseDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly isExecutable: boolean;
}) =>
  exposeOwnCliToAgents(input.baseDir).pipe(
    Effect.provideService(HostProcessEnvironment, input.environment),
    Effect.provideService(HostProcessExecutablePath, input.executable),
    Effect.provideService(HostProcessIsExecutable, input.isExecutable),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

it.layer(NodeServices.layer)("j5 for the server's agents", (it) => {
  it.effect("puts the home's bin first and points its j5 at the running server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, previous, running } = yield* makeHome;
      const bin = path.join(baseDir, "bin");

      // The version before an update left its link behind.
      yield* startServer({
        baseDir,
        environment: { PATH: "/usr/bin" },
        executable: previous,
        isExecutable: true,
      });
      const environment: NodeJS.ProcessEnv = { PATH: `/home/u/.local/bin:${bin}:/usr/bin` };
      yield* startServer({ baseDir, environment, executable: running, isExecutable: true });

      assert.equal(yield* fs.readLink(path.join(bin, "j5")), running);
      assert.deepStrictEqual(yield* fs.readDirectory(bin), ["j5"]);
      // First, and not repeated when a restart inherits it.
      assert.equal(environment["PATH"], `${bin}:/home/u/.local/bin:/usr/bin`);
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing for a server run from source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir } = yield* makeHome;
      const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

      yield* startServer({
        baseDir,
        environment,
        executable: "/usr/local/bin/node",
        isExecutable: false,
      });

      assert.equal(environment["PATH"], "/usr/bin");
      assert.isFalse(yield* fs.exists(path.join(baseDir, "bin")));
    }).pipe(Effect.scoped),
  );
});

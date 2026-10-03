import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import { appendOwnCliToPath } from "./agentPath.ts";

const runtime = "/home/u/.j5code/runtime/versions/2.0.0";

const pathAfterStartup = (input: {
  readonly path: string;
  readonly executable: string;
  readonly isExecutable: boolean;
}) =>
  Effect.gen(function* () {
    const environment: NodeJS.ProcessEnv = { PATH: input.path };
    yield* appendOwnCliToPath.pipe(
      Effect.provideService(HostProcessEnvironment, environment),
      Effect.provideService(HostProcessExecutablePath, input.executable),
      Effect.provideService(HostProcessIsExecutable, input.isExecutable),
      Effect.provideService(HostProcessPlatform, "linux"),
    );
    return environment["PATH"];
  });

it.layer(NodeServices.layer)("j5 on the agents' PATH", (it) => {
  it.effect("appends the release executable's directory after the person's own entries", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* pathAfterStartup({
          path: "/home/u/.local/bin:/usr/bin",
          executable: `${runtime}/j5`,
          isExecutable: true,
        }),
        `/home/u/.local/bin:/usr/bin:${runtime}`,
      );
      // A restart in the same environment doesn't add it twice.
      assert.equal(
        yield* pathAfterStartup({
          path: `/usr/bin:${runtime}`,
          executable: `${runtime}/j5`,
          isExecutable: true,
        }),
        `/usr/bin:${runtime}`,
      );
    }),
  );

  it.effect("leaves PATH alone when there is no j5 beside the server", () =>
    Effect.gen(function* () {
      // Run from source, or by the desktop app's Electron.
      assert.equal(
        yield* pathAfterStartup({
          path: "/usr/bin",
          executable: "/usr/local/bin/node",
          isExecutable: false,
        }),
        "/usr/bin",
      );
      // A pre-rename executable's directory holds `t3`, not `j5`.
      assert.equal(
        yield* pathAfterStartup({
          path: "/usr/bin",
          executable: `${runtime}/t3`,
          isExecutable: true,
        }),
        "/usr/bin",
      );
    }),
  );
});

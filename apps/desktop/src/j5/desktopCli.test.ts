import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { exposeDesktopCli } from "./desktopCli.ts";

const appPath = "/Applications/J5 Code.app/Contents/Resources/app.asar";
const executable = "/Applications/J5 Code.app/Contents/MacOS/J5 Code";

// Runs the startup step for a packaged macOS app whose user's home is `home`.
const launchIn = (home: string, isPackaged = true) =>
  exposeDesktopCli.pipe(
    Effect.provide(
      DesktopEnvironment.layer({
        dirname: `${appPath}/apps/desktop/dist-electron`,
        homeDirectory: home,
        platform: "darwin",
        processArch: "arm64",
        appVersion: "1.0.0",
        appPath,
        isPackaged,
        resourcesPath: "/Applications/J5 Code.app/Contents/Resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
        ),
      ),
    ),
    Effect.provideService(HostProcessExecutablePath, executable),
  );

it.layer(NodeServices.layer)("desktop j5 for agents", (it) => {
  it.effect("writes the script in the J5 home and nothing outside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-desktop-cli-" });
      const bin = path.join(home, ".j5code/bin");

      yield* launchIn(home);

      assert.include(
        yield* fs.readFileString(path.join(bin, "j5")),
        `ELECTRON_RUN_AS_NODE=1 exec '${executable}' '${appPath}/apps/server/dist/bin.mjs' "$@"`,
      );
      // Nothing of the person's is touched: no command on their PATH, no shell file.
      assert.isFalse(yield* fs.exists(path.join(home, ".local")));
      assert.isFalse(yield* fs.exists(path.join(home, ".zshrc")));
    }).pipe(Effect.scoped),
  );

  it.effect("replaces a server install's link without writing through it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-desktop-cli-" });
      const command = path.join(home, ".j5code/bin/j5");
      const serverExecutable = path.join(home, ".j5code/runtime/versions/1.0.0/j5");
      yield* fs.makeDirectory(path.dirname(serverExecutable), { recursive: true });
      yield* fs.writeFileString(serverExecutable, "server binary");
      yield* fs.makeDirectory(path.dirname(command), { recursive: true });
      yield* fs.symlink(serverExecutable, command);

      yield* launchIn(home);

      assert.equal(yield* fs.readFileString(serverExecutable), "server binary");
      assert.include(yield* fs.readFileString(command), "ELECTRON_RUN_AS_NODE=1");
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing in a development build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-desktop-cli-" });

      yield* launchIn(home, false);

      assert.isFalse(yield* fs.exists(path.join(home, ".j5code/bin")));
    }).pipe(Effect.scoped),
  );
});

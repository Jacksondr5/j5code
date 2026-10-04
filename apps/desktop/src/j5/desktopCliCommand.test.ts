import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { J5_PATH_MARKER } from "@t3tools/shared/j5/shellProfile";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { installJ5Command, uninstallJ5Command } from "./desktopCliCommand.ts";

const appPath = "/Applications/J5 Code.app/Contents/Resources/app.asar";

// The packaged macOS app, for a zsh user whose home is `home`.
const inApp =
  (home: string, options: { readonly isPackaged?: boolean; readonly path?: string } = {}) =>
  <A, E>(
    effect: Effect.Effect<
      A,
      E,
      DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    effect.pipe(
      Effect.provide(
        DesktopEnvironment.layer({
          dirname: `${appPath}/apps/desktop/dist-electron`,
          homeDirectory: home,
          platform: "darwin",
          processArch: "arm64",
          appVersion: "1.0.0",
          appPath,
          isPackaged: options.isPackaged ?? true,
          resourcesPath: "/Applications/J5 Code.app/Contents/Resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
          ),
        ),
      ),
      Effect.provideService(HostProcessEnvironment, {
        PATH: options.path ?? "/usr/bin:/bin",
        SHELL: "/bin/zsh",
      }),
    );

it.layer(NodeServices.layer)("desktop install j5 command", (it) => {
  it.effect("links the command, adds the PATH line once, and uninstall undoes both", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-install-command-" });
      const command = path.join(home, ".local/bin/j5");
      const zshrc = path.join(home, ".zshrc");
      yield* fs.writeFileString(zshrc, "alias ll='ls -l'\n");

      const first = yield* installJ5Command.pipe(inApp(home));
      const second = yield* installJ5Command.pipe(inApp(home));

      assert.deepStrictEqual(first, {
        outcome: "installed",
        command,
        profile: zshrc,
        pathHint: null,
      });
      assert.deepStrictEqual(second, first);
      assert.equal(yield* fs.readLink(command), path.join(home, ".j5code/bin/j5"));
      assert.equal(
        yield* fs.readFileString(zshrc),
        `alias ll='ls -l'\nexport PATH="$PATH:${path.join(home, ".local/bin")}" ${J5_PATH_MARKER}\n`,
      );

      const removed = yield* uninstallJ5Command.pipe(inApp(home));
      assert.deepStrictEqual(removed, {
        outcome: "removed",
        command,
        profile: zshrc,
        pathHint: null,
      });
      assert.isFalse(yield* fs.exists(command));
      assert.equal(yield* fs.readFileString(zshrc), "alias ll='ls -l'\n");
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a command-line install's j5 and its PATH line alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-install-command-" });
      const command = path.join(home, ".local/bin/j5");
      const serverExecutable = path.join(home, ".j5code/runtime/versions/1.0.0/j5");
      const zshrc = path.join(home, ".zshrc");
      const profile = `export PATH="$PATH:${path.join(home, ".local/bin")}" ${J5_PATH_MARKER}\n`;
      yield* fs.makeDirectory(path.dirname(serverExecutable), { recursive: true });
      yield* fs.writeFileString(serverExecutable, "");
      yield* fs.makeDirectory(path.dirname(command), { recursive: true });
      yield* fs.symlink(serverExecutable, command);
      yield* fs.writeFileString(zshrc, profile);

      assert.equal((yield* installJ5Command.pipe(inApp(home))).outcome, "kept");
      assert.equal((yield* uninstallJ5Command.pipe(inApp(home))).outcome, "nothing");

      assert.equal(yield* fs.readLink(command), serverExecutable);
      assert.equal(yield* fs.readFileString(zshrc), profile);
    }).pipe(Effect.scoped),
  );

  it.effect("installs and gives the directory to add when the profile can't be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-install-command-" });
      yield* fs.writeFileString(path.join(home, ".zshrc"), "alias ll='ls -l'\n", { mode: 0o444 });

      const result = yield* installJ5Command.pipe(inApp(home));

      assert.deepStrictEqual(result, {
        outcome: "installed",
        command: path.join(home, ".local/bin/j5"),
        profile: null,
        pathHint: path.join(home, ".local/bin"),
      });
      assert.equal(yield* fs.readFileString(path.join(home, ".zshrc")), "alias ll='ls -l'\n");
    }).pipe(Effect.scoped),
  );

  it.effect("touches no startup file when the directory is already on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-install-command-" });

      const result = yield* installJ5Command.pipe(
        inApp(home, { path: `/usr/bin:${path.join(home, ".local/bin")}` }),
      );

      assert.equal(result.outcome, "installed");
      assert.isNull(result.profile);
      assert.isFalse(yield* fs.exists(path.join(home, ".zshrc")));
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing outside the packaged macOS app", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-install-command-" });

      const result = yield* installJ5Command.pipe(inApp(home, { isPackaged: false }));

      assert.equal(result.outcome, "unsupported");
      assert.isFalse(yield* fs.exists(path.join(home, ".local")));
    }).pipe(Effect.scoped),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { J5_PATH_MARKER } from "@t3tools/shared/j5/shellProfile";

import { findJ5PathLines, removeJ5PathLines } from "./shellProfile.ts";

it.layer(NodeServices.layer)("j5 shell profile line", (it) => {
  it.effect("finds the installer's line and removes only that line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-shell-profile-" });
      const zshrc = path.join(home, ".zshrc");
      const bashrc = path.join(home, ".bashrc");
      const before = "alias ll='ls -l'\nexport EDITOR=vim\n";
      // What install.sh appends to a file that already ends with a newline.
      yield* fs.writeFileString(
        zshrc,
        `${before}export PATH="${home}/.local/bin:$PATH" ${J5_PATH_MARKER}\n`,
      );
      yield* fs.writeFileString(bashrc, before);

      const found = yield* findJ5PathLines.pipe(
        Effect.provideService(HostProcessEnvironment, { HOME: home }),
      );
      assert.deepStrictEqual(found, [zshrc]);

      yield* removeJ5PathLines(found);
      assert.equal(yield* fs.readFileString(zshrc), before);
      assert.equal(yield* fs.readFileString(bashrc), before);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("keeps every other byte of a non-UTF-8 profile, including .profile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-shell-profile-bytes-" });
      const profile = path.join(home, ".profile");
      // "export NAME=Ren\xe9" in latin1, which isn't valid UTF-8.
      const before = Uint8Array.from([...Buffer.from("export NAME=Ren"), 0xe9, 0x0a]);
      const line = Buffer.from(`export PATH="${home}/.local/bin:$PATH" ${J5_PATH_MARKER}\n`);
      yield* fs.writeFile(profile, Uint8Array.from([...before, ...line]));

      const found = yield* findJ5PathLines.pipe(
        Effect.provideService(HostProcessEnvironment, { HOME: home }),
      );
      assert.deepStrictEqual(found, [profile]);

      yield* removeJ5PathLines(found);
      assert.deepStrictEqual([...(yield* fs.readFile(profile))], [...before]);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
});

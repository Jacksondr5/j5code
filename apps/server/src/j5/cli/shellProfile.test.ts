import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { J5_PATH_MARKER } from "@t3tools/shared/j5/shellProfile";

import { planShellCleanup, removeJ5PathLines } from "./shellProfile.ts";

// A person's home with an installed J5: the installer's link, a profile
// carrying J5's line, and one without.
const makeHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-shell-cleanup-" });
  const baseDir = path.join(home, ".j5code");
  const command = path.join(home, ".local/bin/j5");
  const executable = path.join(baseDir, "runtime/versions/1.0.0/j5");
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fs.writeFileString(executable, "");
  yield* fs.makeDirectory(path.dirname(command), { recursive: true });
  yield* fs.symlink(executable, command);
  const before = "alias ll='ls -l'\nexport EDITOR=vim\n";
  yield* fs.writeFileString(
    path.join(home, ".zshrc"),
    `${before}export PATH="$PATH:${home}/.local/bin" ${J5_PATH_MARKER}\n`,
  );
  yield* fs.writeFileString(path.join(home, ".bashrc"), before);
  return { home, baseDir, command, before };
});

const plan = (home: string, baseDir: string) =>
  planShellCleanup(baseDir).pipe(Effect.provideService(HostProcessEnvironment, { HOME: home }));

it.layer(NodeServices.layer)("j5 uninstall's shell cleanup", (it) => {
  it.effect("takes the installer's link and only J5's line, however uninstall was started", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, baseDir, command, before } = yield* makeHome;

      const { profiles, installerLink } = yield* plan(home, baseDir);
      assert.equal(installerLink, command);
      assert.deepStrictEqual(profiles, [path.join(home, ".zshrc")]);

      yield* removeJ5PathLines(profiles);
      assert.equal(yield* fs.readFileString(path.join(home, ".zshrc")), before);
      assert.equal(yield* fs.readFileString(path.join(home, ".bashrc")), before);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("takes the link the desktop app's install command made", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, baseDir, command } = yield* makeHome;
      yield* fs.remove(command);
      yield* fs.symlink(path.join(baseDir, "bin/j5"), command);

      const { profiles, installerLink } = yield* plan(home, baseDir);
      assert.equal(installerLink, command);
      assert.deepStrictEqual(profiles, [path.join(home, ".zshrc")]);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("leaves another home's j5 and its line alone", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home } = yield* makeHome;
      // An agent uninstalling its scratch home while the real install stays.
      assert.deepStrictEqual(yield* plan(home, path.join(home, "scratch/.j5code")), {
        profiles: [],
        installerLink: undefined,
      });
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("keeps every other byte of a non-UTF-8 profile, including .profile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-shell-cleanup-bytes-" });
      const profile = path.join(home, ".profile");
      // "export NAME=Ren\xe9" in latin1, which isn't valid UTF-8.
      const before = Uint8Array.from([...Buffer.from("export NAME=Ren"), 0xe9, 0x0a]);
      const line = Buffer.from(`export PATH="$PATH:${home}/.local/bin" ${J5_PATH_MARKER}\n`);
      yield* fs.writeFile(profile, Uint8Array.from([...before, ...line]));

      // No `j5` is left at all, so the orphaned line goes.
      const { profiles } = yield* plan(home, path.join(home, ".j5code"));
      assert.deepStrictEqual(profiles, [profile]);

      yield* removeJ5PathLines(profiles);
      assert.deepStrictEqual([...(yield* fs.readFile(profile))], [...before]);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
});

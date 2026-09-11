import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { agentPersonaFolderGitStatus } from "./agentPersonaLibraryGit.ts";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(
        "git",
        ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
        { cwd },
      ),
    );
    assert.equal(exitCode, 0, `git ${args.join(" ")}`);
  });

describe("library folder git status", () => {
  it.effect("reports nothing outside a repository and folder-scoped changes inside one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-persona-git-" });
      const plain = path.join(root, "plain");
      yield* fs.makeDirectory(plain);
      // Temp directories may sit inside another repository; a git-free answer needs a real one.
      const repo = path.join(root, "repo");
      const personas = path.join(repo, "personas");
      yield* fs.makeDirectory(personas, { recursive: true });
      yield* git(repo, "init", "-q", "-b", "main");
      yield* fs.writeFileString(path.join(repo, "README.md"), "team library");
      yield* git(repo, "add", ".");
      yield* git(repo, "commit", "-q", "-m", "init");

      const clean = yield* agentPersonaFolderGitStatus(personas);
      assert.isNotNull(clean);
      assert.equal(clean!.repositoryRoot, yield* fs.realPath(repo));
      assert.equal(clean!.uncommittedChanges, false);
      assert.equal(clean!.remoteAhead, null);

      yield* fs.writeFileString(path.join(personas, "scout.yaml"), "id: scout");
      assert.equal((yield* agentPersonaFolderGitStatus(personas))!.uncommittedChanges, true);
      // Changes elsewhere in the repository do not count against this folder.
      yield* git(repo, "add", ".");
      yield* git(repo, "commit", "-q", "-m", "add scout");
      yield* fs.writeFileString(path.join(repo, "README.md"), "changed");
      assert.equal((yield* agentPersonaFolderGitStatus(personas))!.uncommittedChanges, false);

      assert.isNull(yield* agentPersonaFolderGitStatus(path.join(root, "does-not-exist")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is null without a process spawner", () =>
    Effect.gen(function* () {
      assert.isNull(yield* agentPersonaFolderGitStatus("/"));
    }),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ArtifactWorkspace from "./ArtifactWorkspace.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ArtifactWorkspace.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = Effect.fn("ArtifactWorkspace.test.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const process = yield* VcsProcess.VcsProcess;
  return yield* process.run({
    operation: "ArtifactWorkspace.test.git",
    command: "git",
    args,
    cwd,
    timeoutMs: 10_000,
  });
});

describe("ArtifactWorkspace", () => {
  it.effect("exports a plan beneath an ignored artifacts directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "j5-artifacts-git-" });
        yield* git(cwd, ["init"]);

        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        yield* artifacts.exportPlan({ cwd, markdown: "# Plan\n\nShip it." });

        const listed = yield* artifacts.list(cwd);
        assert.equal(listed.length, 1);
        assert.equal(listed[0]!.path, "plan.md");
        const read = yield* artifacts.read({ cwd, relativePath: listed[0]!.path });
        assert.equal(read.encoding, "utf8");
        assert.equal(read.content, "# Plan\n\nShip it.\n");

        const ignored = yield* git(cwd, ["check-ignore", "--no-index", "--", "artifacts"]);
        assert.equal(ignored.exitCode, 0);
        assert.equal((yield* git(cwd, ["status", "--short"])).stdout.trim(), "");

        const excludePath = (yield* git(cwd, [
          "rev-parse",
          "--git-path",
          "info/exclude",
        ])).stdout.trim();
        const exclude = yield* fileSystem.readFileString(path.resolve(cwd, excludePath));
        assert.equal(
          exclude
            .split(/\r?\n/u)
            .filter((line) => line === ArtifactWorkspace.ARTIFACT_IGNORE_PATTERN).length,
          1,
        );

        yield* artifacts.exportPlan({ cwd, markdown: "# Plan\n\nShip it." });
        const excludeAfterRetry = yield* fileSystem.readFileString(path.resolve(cwd, excludePath));
        assert.equal(excludeAfterRetry, exclude);
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("rejects reads that leave the artifacts directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "j5-artifacts-path-" });
        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        yield* artifacts.prepare(cwd);

        const result = yield* Effect.exit(artifacts.read({ cwd, relativePath: "../outside.txt" }));
        assert.isTrue(result._tag === "Failure");
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("watches for files created in the artifacts directory", () =>
    Effect.gen(function* () {
      let watchedPath: string | null = null;
      let recursive = false;
      const changes = ArtifactWorkspace.watchArtifactDirectory(
        {
          watch: (path, options) => {
            watchedPath = path;
            recursive = options?.recursive ?? false;
            return Stream.make({ _tag: "Create" as const, path: "new-plan.md" });
          },
        },
        "/workspace/artifacts",
      );

      assert.equal((yield* Stream.runCollect(changes)).length, 1);
      assert.equal(watchedPath, "/workspace/artifacts");
      assert.isTrue(recursive);
    }),
  );

  it.effect("refuses to hide an already tracked artifacts directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "j5-artifacts-tracked-" });
        yield* git(cwd, ["init"]);
        yield* fileSystem.makeDirectory(path.join(cwd, "artifacts"));
        yield* fileSystem.writeFileString(path.join(cwd, "artifacts", "existing.md"), "tracked");
        yield* git(cwd, ["add", "artifacts/existing.md"]);

        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        const result = yield* Effect.exit(artifacts.prepare(cwd));
        assert.isTrue(result._tag === "Failure");
        if (result._tag === "Failure") {
          assert.include(String(result.cause), "already contains tracked files");
        }
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("uses Git's resolved exclude file from a linked worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const container = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "j5-artifacts-worktree-",
        });
        const repository = path.join(container, "repository");
        const linked = path.join(container, "linked");
        yield* fileSystem.makeDirectory(repository);
        yield* git(repository, ["init"]);
        yield* git(repository, ["config", "user.email", "artifacts@example.test"]);
        yield* git(repository, ["config", "user.name", "Artifacts Test"]);
        yield* fileSystem.writeFileString(path.join(repository, "README.md"), "# Test\n");
        yield* git(repository, ["add", "README.md"]);
        yield* git(repository, ["commit", "-m", "initial"]);
        yield* git(repository, ["worktree", "add", "-b", "artifacts-test", linked]);

        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        yield* artifacts.exportPlan({
          cwd: linked,
          markdown: "# Linked worktree plan",
        });

        assert.equal((yield* git(linked, ["status", "--short"])).stdout.trim(), "");
        assert.isTrue(yield* fileSystem.exists(path.join(linked, "artifacts", "plan.md")));
        const excludePath = (yield* git(linked, [
          "rev-parse",
          "--git-path",
          "info/exclude",
        ])).stdout.trim();
        const exclude = yield* fileSystem.readFileString(path.resolve(linked, excludePath));
        assert.include(exclude, ArtifactWorkspace.ARTIFACT_IGNORE_PATTERN);
      }).pipe(Effect.provide(TestLayer)),
    ),
  );
});

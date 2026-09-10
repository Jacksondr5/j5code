import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { ProjectId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ArtifactWorkspace from "./ArtifactWorkspace.ts";

const TestLayer = ArtifactWorkspace.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-artifacts-state-" })),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project:artifacts-test");

describe("ArtifactWorkspace", () => {
  it.effect("exports a plan beneath server-owned application storage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;

        yield* artifacts.exportPlan({ projectId, markdown: "# Plan\n\nShip it." });

        const listed = yield* artifacts.list(projectId);
        assert.equal(listed.length, 1);
        assert.equal(listed[0]!.path, "plan.md");
        const read = yield* artifacts.read({ projectId, relativePath: listed[0]!.path });
        assert.equal(read.encoding, "utf8");
        assert.equal(read.content, "# Plan\n\nShip it.\n");

        const planPath = path.join(
          serverConfig.stateDir,
          ArtifactWorkspace.ARTIFACT_DIRECTORY_NAME,
          ArtifactWorkspace.artifactProjectDirectoryName(projectId),
          "plan.md",
        );
        assert.isTrue(yield* fileSystem.exists(planPath));
        assert.isFalse(
          yield* fileSystem.exists(path.join(serverConfig.cwd, "artifacts", "plan.md")),
        );

        yield* artifacts.exportPlan({ projectId, markdown: "# Plan\n\nShip it." });
        assert.equal(yield* fileSystem.readFileString(planPath), "# Plan\n\nShip it.\n");
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("keeps projects isolated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        const otherProjectId = ProjectId.make("project:other-artifacts-test");
        yield* artifacts.exportPlan({ projectId, markdown: "# First" });
        yield* artifacts.exportPlan({ projectId: otherProjectId, markdown: "# Second" });

        assert.equal(
          (yield* artifacts.read({ projectId, relativePath: "plan.md" })).content,
          "# First\n",
        );
        assert.equal(
          (yield* artifacts.read({ projectId: otherProjectId, relativePath: "plan.md" })).content,
          "# Second\n",
        );
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("writes nested text artifacts through the application boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        const written = yield* artifacts.write({
          projectId,
          relativePath: "diagrams/flow.html",
          content: "<main>Flow</main>",
        });

        assert.equal(written.path, "diagrams/flow.html");
        assert.equal(
          (yield* artifacts.read({ projectId, relativePath: written.path })).content,
          "<main>Flow</main>",
        );
        const listed = yield* artifacts.list(projectId);
        assert.equal(listed[0]?.path, "diagrams/flow.html");
        assert.equal(listed[0]?.byteLength, 17);
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("rejects reads that leave the artifacts directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        yield* artifacts.prepare(projectId);

        const result = yield* Effect.exit(
          artifacts.read({ projectId, relativePath: "../outside.txt" }),
        );
        assert.isTrue(result._tag === "Failure");
        const writeResult = yield* Effect.exit(
          artifacts.write({ projectId, relativePath: "../outside.txt", content: "nope" }),
        );
        assert.isTrue(writeResult._tag === "Failure");
        const windowsWriteResult = yield* Effect.exit(
          artifacts.write({ projectId, relativePath: "..\\outside.txt", content: "nope" }),
        );
        assert.isTrue(windowsWriteResult._tag === "Failure");
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects an escaping directory symlink before creating external directories",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const serverConfig = yield* ServerConfig.ServerConfig;
          const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
          const outside = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "j5-artifacts-outside-",
          });

          yield* artifacts.prepare(projectId);
          const artifactRoot = path.join(
            serverConfig.stateDir,
            ArtifactWorkspace.ARTIFACT_DIRECTORY_NAME,
            ArtifactWorkspace.artifactProjectDirectoryName(projectId),
          );
          yield* fileSystem.symlink(outside, path.join(artifactRoot, "link"));

          const result = yield* Effect.exit(
            artifacts.write({
              projectId,
              relativePath: "link/new-directory/file.md",
              content: "must not escape",
            }),
          );

          assert.isTrue(result._tag === "Failure");
          assert.isFalse(yield* fileSystem.exists(path.join(outside, "new-directory")));
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
        "/application/artifacts/project",
      );

      assert.equal((yield* Stream.runCollect(changes)).length, 1);
      assert.equal(watchedPath, "/application/artifacts/project");
      assert.isTrue(recursive);
    }),
  );
});

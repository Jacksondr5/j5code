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

  it.effect("deletes an artifact without affecting other project artifacts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        yield* artifacts.write({ projectId, relativePath: "notes/old.md", content: "old" });
        yield* artifacts.write({ projectId, relativePath: "notes/keep.md", content: "keep" });

        const deletedPath = yield* artifacts.delete({ projectId, relativePath: "./notes\\old.md" });
        assert.equal(deletedPath, "notes/old.md");

        const artifactRoot = path.join(
          serverConfig.stateDir,
          ArtifactWorkspace.ARTIFACT_DIRECTORY_NAME,
          ArtifactWorkspace.artifactProjectDirectoryName(projectId),
        );
        assert.equal(
          (yield* artifacts.read({ projectId, relativePath: "notes/keep.md" })).content,
          "keep",
        );
        assert.isFalse(yield* fileSystem.exists(path.join(artifactRoot, "notes/old.md")));
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("stacks handoff versions inside one file, newest first, and converges on retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        const relativePath = "handoffs/critic/ReviewHandoff-8f3a2c1d.md";

        yield* artifacts.writeVersioned({
          projectId,
          relativePath,
          content: "# Review\n\nFirst pass.",
        });
        const first = yield* artifacts.read({ projectId, relativePath });
        assert.match(
          first.content,
          /^<!-- j5-artifact-versions: handoffs\/critic\/ReviewHandoff-8f3a2c1d\.md; 1@\S+ -->\n/,
        );
        assert.include(first.content, "# Review\n");
        assert.include(first.content, "1 version, newest first");
        assert.match(first.content, /## Version 1 · \S+ · current\n\n# Review\n\nFirst pass\./);
        const versions = ArtifactWorkspace.parseArtifactVersions(first.content, "now");
        assert.deepEqual(
          versions.map(({ number, content }) => ({ number, content })),
          [{ number: 1, content: "# Review\n\nFirst pass." }],
        );

        yield* artifacts.writeVersioned({
          projectId,
          relativePath,
          content: "# Review\n\nSecond pass.",
        });
        const second = yield* artifacts.read({ projectId, relativePath });
        assert.include(second.content, "2 versions, newest first");
        assert.match(second.content, /^<!-- j5-artifact-versions: \S+; 2@\S+ 1@\S+ -->\n/);
        const stacked = ArtifactWorkspace.parseArtifactVersions(second.content, "now");
        assert.deepEqual(
          stacked.map(({ number, content }) => ({ number, content })),
          [
            { number: 2, content: "# Review\n\nSecond pass." },
            { number: 1, content: "# Review\n\nFirst pass." },
          ],
        );
        assert.isTrue(
          second.content.indexOf("Second pass.") < second.content.indexOf("First pass."),
        );
        assert.match(second.content, /## Version 2 · \S+ · current/);
        assert.match(second.content, /## Version 1 · \S+\n/);
        assert.notMatch(second.content, /## Version 1 · \S+ · current/);

        // An identical rewrite is idempotent: same bytes, still two versions.
        yield* artifacts.writeVersioned({
          projectId,
          relativePath,
          content: "# Review\n\nSecond pass.",
        });
        const third = yield* artifacts.read({ projectId, relativePath });
        assert.equal(third.content, second.content);

        // A plain artifact path keeps overwrite semantics.
        yield* artifacts.write({ projectId, relativePath: "notes.md", content: "one" });
        yield* artifacts.write({ projectId, relativePath: "notes.md", content: "two" });
        assert.equal(
          (yield* artifacts.read({ projectId, relativePath: "notes.md" })).content,
          "two",
        );
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("drops the oldest handoff versions when the file would exceed the size limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const relativePath = "handoffs/builder/CodeCompleteHandoff-1a2b3c4d.md";
        const big = (label: string) => `# ${label}\n\n${"x".repeat(3 * 1024 * 1024)}`;
        const existing = ArtifactWorkspace.stackArtifactVersion({
          relativePath,
          existing: null,
          content: big("one"),
          now: "2026-09-14T00:00:00.000Z",
          maxBytes: ArtifactWorkspace.MAX_ARTIFACT_BYTES,
        });
        const stacked = ArtifactWorkspace.stackArtifactVersion({
          relativePath,
          existing: existing.rendered,
          content: big("two"),
          now: "2026-09-14T00:01:00.000Z",
          maxBytes: ArtifactWorkspace.MAX_ARTIFACT_BYTES,
        });
        assert.isTrue(
          new TextEncoder().encode(stacked.rendered).byteLength <=
            ArtifactWorkspace.MAX_ARTIFACT_BYTES,
        );
        assert.include(
          stacked.rendered,
          "1 version, newest first; 1 older version dropped to stay under the size limit",
        );
        const versions = ArtifactWorkspace.parseArtifactVersions(stacked.rendered, "now");
        assert.deepEqual(
          versions.map(({ number }) => number),
          [2],
        );
        assert.include(versions[0]!.content, "# two");

        // A pre-existing file without the marker becomes version 1 beneath the new version.
        const adopted = ArtifactWorkspace.stackArtifactVersion({
          relativePath,
          existing: "Legacy body",
          content: "New body",
          now: "2026-09-14T00:02:00.000Z",
          maxBytes: ArtifactWorkspace.MAX_ARTIFACT_BYTES,
        });
        assert.deepEqual(
          ArtifactWorkspace.parseArtifactVersions(adopted.rendered, "now").map(
            ({ number, content }) => ({ number, content }),
          ),
          [
            { number: 2, content: "New body" },
            { number: 1, content: "Legacy body" },
          ],
        );
        // The artifact name fills in when the newest version has no heading.
        assert.include(adopted.rendered, "\n# CodeCompleteHandoff\n");
        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        assert.isDefined(artifacts.writeVersioned);
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it("keeps bodies that quote a version heading or end with a horizontal rule intact", () => {
    const relativePath = "handoffs/critic/ReviewHandoff-8f3a2c1d.md";
    const maxBytes = ArtifactWorkspace.MAX_ARTIFACT_BYTES;
    const one = ArtifactWorkspace.stackArtifactVersion({
      relativePath,
      existing: null,
      content: "# Review\n\nFirst pass.\n\n---",
      now: "2026-09-15T00:00:00.000Z",
      maxBytes,
    });
    const [firstVersion] = ArtifactWorkspace.parseArtifactVersions(one.rendered, "now");
    // The second body quotes the first heading exactly as it appeared (current at the time) and
    // also contains a line shaped like a heading for a version that does not exist.
    const quoted = `## Version 1 · ${firstVersion!.timestamp} · current`;
    const two = ArtifactWorkspace.stackArtifactVersion({
      relativePath,
      existing: one.rendered,
      content: `# Review\n\nRevisiting:\n\n> ${quoted}\n${quoted}\n## Version 9 · 2026-01-01T00:00:00.000Z\n\nSecond pass.\n---`,
      now: "2026-09-15T00:01:00.000Z",
      maxBytes,
    });
    const versions = ArtifactWorkspace.parseArtifactVersions(two.rendered, "now");
    assert.deepEqual(
      versions.map(({ number, content }) => ({ number, content })),
      [
        {
          number: 2,
          content: `# Review\n\nRevisiting:\n\n> ${quoted}\n${quoted}\n## Version 9 · 2026-01-01T00:00:00.000Z\n\nSecond pass.\n---`,
        },
        { number: 1, content: "# Review\n\nFirst pass.\n\n---" },
      ],
    );
    // A third stack still round-trips both earlier bodies byte for byte.
    const three = ArtifactWorkspace.stackArtifactVersion({
      relativePath,
      existing: two.rendered,
      content: "Third pass.",
      now: "2026-09-15T00:02:00.000Z",
      maxBytes,
    });
    assert.deepEqual(
      ArtifactWorkspace.parseArtifactVersions(three.rendered, "now").map(({ content }) => content),
      ["Third pass.", versions[0]!.content, versions[1]!.content],
    );
    // A marker whose headings were hand-edited away adopts the whole file as one version.
    // (The quoted copy carries " · current"; only the real heading matches this pattern.)
    const edited = three.rendered.replace(/^## Version 1 · \S+$/m, "## Version one");
    assert.deepEqual(
      ArtifactWorkspace.parseArtifactVersions(edited, "now").map(({ number }) => number),
      [1],
    );
  });

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
        const deleteResult = yield* Effect.exit(
          artifacts.delete({ projectId, relativePath: "../outside.txt" }),
        );
        assert.isTrue(deleteResult._tag === "Failure");
        const windowsDeleteResult = yield* Effect.exit(
          artifacts.delete({ projectId, relativePath: "..\\outside.txt" }),
        );
        assert.isTrue(windowsDeleteResult._tag === "Failure");
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

  it.effect.skipIf(!symlinksSupported)("does not delete through an artifact symlink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const artifacts = yield* ArtifactWorkspace.ArtifactWorkspace;
        yield* artifacts.write({ projectId, relativePath: "target.md", content: "keep" });
        const artifactRoot = path.join(
          serverConfig.stateDir,
          ArtifactWorkspace.ARTIFACT_DIRECTORY_NAME,
          ArtifactWorkspace.artifactProjectDirectoryName(projectId),
        );
        yield* fileSystem.symlink(
          path.join(artifactRoot, "target.md"),
          path.join(artifactRoot, "link.md"),
        );

        const result = yield* Effect.exit(artifacts.delete({ projectId, relativePath: "link.md" }));

        assert.isTrue(result._tag === "Failure");
        assert.equal(
          (yield* artifacts.read({ projectId, relativePath: "target.md" })).content,
          "keep",
        );
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

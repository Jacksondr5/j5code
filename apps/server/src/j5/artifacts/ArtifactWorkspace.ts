import type { ArtifactContent, ArtifactEntry, ProjectId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";

export const ARTIFACT_DIRECTORY_NAME = "artifacts";
export const MAX_ARTIFACT_COUNT = 500;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export const artifactProjectDirectoryName = (projectId: ProjectId): string =>
  NodeCrypto.createHash("sha256").update(projectId).digest("hex");

export class ArtifactWorkspaceError extends Schema.TaggedErrorClass<ArtifactWorkspaceError>()(
  "ArtifactWorkspaceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ArtifactWorkspaceShape {
  readonly prepare: (projectId: ProjectId) => Effect.Effect<void, ArtifactWorkspaceError>;
  readonly list: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ArtifactEntry>, ArtifactWorkspaceError>;
  readonly read: (input: {
    readonly projectId: ProjectId;
    readonly relativePath: string;
  }) => Effect.Effect<ArtifactContent, ArtifactWorkspaceError>;
  readonly write: (input: {
    readonly projectId: ProjectId;
    readonly relativePath: string;
    readonly content: string;
  }) => Effect.Effect<ArtifactEntry, ArtifactWorkspaceError>;
  readonly exportPlan: (input: {
    readonly projectId: ProjectId;
    readonly markdown: string;
  }) => Effect.Effect<void, ArtifactWorkspaceError>;
  readonly watch: (projectId: ProjectId) => Stream.Stream<void, ArtifactWorkspaceError>;
}

export class ArtifactWorkspace extends Context.Service<ArtifactWorkspace, ArtifactWorkspaceShape>()(
  "t3/j5/artifacts/ArtifactWorkspace",
) {}

const workspaceError = (operation: string, detail: string) => (cause: unknown) =>
  new ArtifactWorkspaceError({ operation, detail, cause });

export const watchArtifactDirectory = (
  fileSystem: Pick<FileSystem.FileSystem, "watch">,
  artifactRoot: string,
) =>
  fileSystem.watch(artifactRoot, { recursive: true }).pipe(
    Stream.debounce(Duration.millis(100)),
    Stream.map(() => undefined),
    Stream.mapError(
      workspaceError("watch-artifacts", "The artifacts directory could not be watched."),
    ),
  );

const normalizeText = (value: string) => (value.endsWith("\n") ? value : `${value}\n`);
const normalizeArtifactRelativePath = (value: string) => value.replaceAll("\\", "/");

const isPathWithin = (path: Path.Path, parent: string, candidate: string) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const looksBinary = (bytes: Uint8Array) => {
  const inspected = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  return inspected.some((byte) => byte === 0);
};

export const layer = Layer.effect(
  ArtifactWorkspace,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const artifactsDir = path.join(serverConfig.stateDir, ARTIFACT_DIRECTORY_NAME);

    const artifactRootFor = (projectId: ProjectId) =>
      path.join(artifactsDir, artifactProjectDirectoryName(projectId));

    const resolveNearestExistingAncestor = Effect.fn(
      "ArtifactWorkspace.resolveNearestExistingAncestor",
    )(function* (candidate: string, boundary: string) {
      let current = candidate;
      while (
        !(yield* fileSystem
          .exists(current)
          .pipe(
            Effect.mapError(
              workspaceError("write-artifact", "The artifact directory could not be inspected."),
            ),
          ))
      ) {
        const parent = path.dirname(current);
        if (parent === current || !isPathWithin(path, boundary, parent)) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "Artifact paths cannot leave the artifacts directory.",
          });
        }
        current = parent;
      }
      return yield* fileSystem
        .realPath(current)
        .pipe(
          Effect.mapError(
            workspaceError("write-artifact", "The artifact directory could not be resolved."),
          ),
        );
    });

    const resolveArtifactsBase = Effect.fn("ArtifactWorkspace.resolveArtifactsBase")(function* () {
      yield* fileSystem
        .makeDirectory(artifactsDir, { recursive: true })
        .pipe(
          Effect.mapError(
            workspaceError(
              "create-artifacts",
              "The application artifacts directory could not be created.",
            ),
          ),
        );
      return yield* fileSystem
        .realPath(artifactsDir)
        .pipe(
          Effect.mapError(
            workspaceError(
              "resolve-artifacts",
              "The application artifacts directory could not be resolved.",
            ),
          ),
        );
    });

    const resolveExistingArtifactRoot = Effect.fn("ArtifactWorkspace.resolveExistingArtifactRoot")(
      function* (projectId: ProjectId) {
        const artifactsBase = yield* resolveArtifactsBase();
        const artifactRoot = artifactRootFor(projectId);
        const exists = yield* fileSystem
          .exists(artifactRoot)
          .pipe(
            Effect.mapError(
              workspaceError(
                "resolve-artifacts",
                "The artifacts directory could not be inspected.",
              ),
            ),
          );
        if (!exists) return { artifactRoot, realArtifactRoot: null };
        const realArtifactRoot = yield* fileSystem
          .realPath(artifactRoot)
          .pipe(
            Effect.mapError(
              workspaceError("resolve-artifacts", "The artifacts directory could not be resolved."),
            ),
          );
        if (!isPathWithin(path, artifactsBase, realArtifactRoot)) {
          return yield* new ArtifactWorkspaceError({
            operation: "resolve-artifacts",
            detail: "The project artifacts directory cannot link outside application storage.",
          });
        }
        return { artifactRoot, realArtifactRoot };
      },
    );

    const prepare: ArtifactWorkspaceShape["prepare"] = Effect.fn("ArtifactWorkspace.prepare")(
      function* (projectId) {
        yield* resolveArtifactsBase();
        yield* fileSystem
          .makeDirectory(artifactRootFor(projectId), { recursive: true })
          .pipe(
            Effect.mapError(
              workspaceError(
                "create-artifacts",
                "The project artifacts directory could not be created.",
              ),
            ),
          );
      },
    );

    const list: ArtifactWorkspaceShape["list"] = Effect.fn("ArtifactWorkspace.list")(
      function* (projectId) {
        yield* prepare(projectId);
        const workspace = yield* resolveExistingArtifactRoot(projectId);
        if (workspace.realArtifactRoot === null) return [];
        const names = yield* fileSystem
          .readDirectory(workspace.realArtifactRoot, { recursive: true })
          .pipe(
            Effect.mapError(
              workspaceError("list-artifacts", "The artifacts directory could not be listed."),
            ),
          );
        if (names.length > MAX_ARTIFACT_COUNT * 4) {
          return yield* new ArtifactWorkspaceError({
            operation: "list-artifacts",
            detail: `The artifacts directory is too large to browse (maximum ${MAX_ARTIFACT_COUNT} files).`,
          });
        }

        const entries = yield* Effect.forEach(
          names,
          (name) =>
            Effect.gen(function* () {
              const absolutePath = path.join(workspace.realArtifactRoot!, name);
              const realPath = yield* Effect.result(fileSystem.realPath(absolutePath));
              if (
                Result.isFailure(realPath) ||
                !isPathWithin(path, workspace.realArtifactRoot!, realPath.success)
              ) {
                return null;
              }
              const info = yield* Effect.result(fileSystem.stat(realPath.success));
              if (Result.isFailure(info) || info.success.type !== "File") return null;
              return {
                path: name.replaceAll("\\", "/"),
                byteLength: Number(info.success.size),
                modifiedAt: Option.match(info.success.mtime, {
                  onNone: () => null,
                  onSome: (value) => value.toISOString(),
                }),
              } satisfies ArtifactEntry;
            }),
          { concurrency: 16 },
        );
        return entries
          .filter((entry): entry is ArtifactEntry => entry !== null)
          .slice(0, MAX_ARTIFACT_COUNT)
          .toSorted((left, right) => left.path.localeCompare(right.path));
      },
    );

    const read: ArtifactWorkspaceShape["read"] = Effect.fn("ArtifactWorkspace.read")(
      function* (input) {
        const workspace = yield* resolveExistingArtifactRoot(input.projectId);
        if (workspace.realArtifactRoot === null) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "The artifact does not exist.",
          });
        }
        const relativePath = normalizeArtifactRelativePath(input.relativePath);
        if (relativePath.trim().length === 0 || path.isAbsolute(relativePath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "Artifact paths must be relative to the artifacts directory.",
          });
        }
        const requestedPath = path.resolve(workspace.realArtifactRoot, relativePath);
        if (!isPathWithin(path, workspace.realArtifactRoot, requestedPath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "Artifact paths cannot leave the artifacts directory.",
          });
        }
        const realPath = yield* fileSystem
          .realPath(requestedPath)
          .pipe(Effect.mapError(workspaceError("read-artifact", "The artifact does not exist.")));
        if (!isPathWithin(path, workspace.realArtifactRoot, realPath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "Artifact links cannot leave the artifacts directory.",
          });
        }
        const info = yield* fileSystem
          .stat(realPath)
          .pipe(
            Effect.mapError(
              workspaceError("read-artifact", "The artifact could not be inspected."),
            ),
          );
        if (info.type !== "File") {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "Only artifact files can be opened.",
          });
        }
        if (Number(info.size) > MAX_ARTIFACT_BYTES) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: `This artifact is larger than the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB preview limit.`,
          });
        }
        const bytes = yield* fileSystem
          .readFile(realPath)
          .pipe(
            Effect.mapError(workspaceError("read-artifact", "The artifact could not be read.")),
          );
        const binary = looksBinary(bytes);
        return {
          path: relativePath,
          byteLength: bytes.byteLength,
          encoding: binary ? "base64" : "utf8",
          content: binary ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes),
        } satisfies ArtifactContent;
      },
    );

    const write: ArtifactWorkspaceShape["write"] = Effect.fn("ArtifactWorkspace.write")(
      function* (input) {
        const relativePath = normalizeArtifactRelativePath(input.relativePath);
        if (relativePath.trim().length === 0 || path.isAbsolute(relativePath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "Artifact paths must be relative to the artifacts directory.",
          });
        }
        const byteLength = new TextEncoder().encode(input.content).byteLength;
        if (byteLength > MAX_ARTIFACT_BYTES) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: `This artifact is larger than the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB limit.`,
          });
        }

        yield* prepare(input.projectId);
        const workspace = yield* resolveExistingArtifactRoot(input.projectId);
        if (workspace.realArtifactRoot === null) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "The project artifacts directory could not be resolved.",
          });
        }
        const requestedPath = path.resolve(workspace.realArtifactRoot, relativePath);
        if (!isPathWithin(path, workspace.realArtifactRoot, requestedPath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "Artifact paths cannot leave the artifacts directory.",
          });
        }

        const parent = path.dirname(requestedPath);
        const realExistingAncestor = yield* resolveNearestExistingAncestor(
          parent,
          workspace.realArtifactRoot,
        );
        if (!isPathWithin(path, workspace.realArtifactRoot, realExistingAncestor)) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "Artifact links cannot leave the artifacts directory.",
          });
        }
        yield* fileSystem
          .makeDirectory(parent, { recursive: true })
          .pipe(
            Effect.mapError(
              workspaceError("write-artifact", "The artifact directory could not be created."),
            ),
          );
        const realParent = yield* fileSystem
          .realPath(parent)
          .pipe(
            Effect.mapError(
              workspaceError("write-artifact", "The artifact directory could not be resolved."),
            ),
          );
        if (!isPathWithin(path, workspace.realArtifactRoot, realParent)) {
          return yield* new ArtifactWorkspaceError({
            operation: "write-artifact",
            detail: "Artifact links cannot leave the artifacts directory.",
          });
        }

        yield* writeFileStringAtomically({ filePath: requestedPath, contents: input.content }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(workspaceError("write-artifact", "The artifact could not be written.")),
        );
        const info = yield* fileSystem
          .stat(requestedPath)
          .pipe(
            Effect.mapError(
              workspaceError("write-artifact", "The written artifact could not be inspected."),
            ),
          );
        return {
          path: relativePath,
          byteLength: Number(info.size),
          modifiedAt: Option.match(info.mtime, {
            onNone: () => null,
            onSome: (value) => value.toISOString(),
          }),
        } satisfies ArtifactEntry;
      },
    );

    const exportPlan: ArtifactWorkspaceShape["exportPlan"] = Effect.fn(
      "ArtifactWorkspace.exportPlan",
    )(function* (input) {
      yield* prepare(input.projectId);
      const workspace = yield* resolveExistingArtifactRoot(input.projectId);
      if (workspace.realArtifactRoot === null) {
        return yield* new ArtifactWorkspaceError({
          operation: "resolve-artifacts",
          detail: "The project artifacts directory could not be resolved.",
        });
      }
      const realArtifactRoot = yield* fileSystem
        .realPath(workspace.artifactRoot)
        .pipe(
          Effect.mapError(
            workspaceError("resolve-artifacts", "The artifacts directory could not be resolved."),
          ),
        );
      const realArtifactsBase = yield* fileSystem
        .realPath(artifactsDir)
        .pipe(
          Effect.mapError(
            workspaceError(
              "resolve-artifacts",
              "The application artifacts directory could not be resolved.",
            ),
          ),
        );
      if (!isPathWithin(path, realArtifactsBase, realArtifactRoot)) {
        return yield* new ArtifactWorkspaceError({
          operation: "resolve-artifacts",
          detail: "The project artifacts directory cannot link outside application storage.",
        });
      }

      const planPath = path.join(realArtifactRoot, "plan.md");
      const contents = normalizeText(input.markdown);
      const current = yield* Effect.result(fileSystem.readFileString(planPath));
      if (Result.isSuccess(current) && current.success === contents) return;
      yield* writeFileStringAtomically({ filePath: planPath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          workspaceError("write-plan", "The completed plan could not be saved as an artifact."),
        ),
      );
    });

    const watch: ArtifactWorkspaceShape["watch"] = (projectId) =>
      Stream.unwrap(
        prepare(projectId).pipe(
          Effect.andThen(resolveExistingArtifactRoot(projectId)),
          Effect.flatMap((workspace) =>
            workspace.realArtifactRoot === null
              ? Effect.fail(
                  new ArtifactWorkspaceError({
                    operation: "watch-artifacts",
                    detail: "The artifacts directory does not exist.",
                  }),
                )
              : Effect.succeed(watchArtifactDirectory(fileSystem, workspace.realArtifactRoot)),
          ),
        ),
      );

    return ArtifactWorkspace.of({ prepare, list, read, write, exportPlan, watch });
  }),
);

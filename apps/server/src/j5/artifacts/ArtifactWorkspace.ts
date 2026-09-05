import type { ArtifactContent, ArtifactEntry } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";

export const ARTIFACT_DIRECTORY_NAME = "artifacts";
export const ARTIFACT_IGNORE_PATTERN = "/artifacts/";
export const MAX_ARTIFACT_COUNT = 500;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

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
  readonly prepare: (cwd: string) => Effect.Effect<void, ArtifactWorkspaceError>;
  readonly list: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactEntry>, ArtifactWorkspaceError>;
  readonly read: (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) => Effect.Effect<ArtifactContent, ArtifactWorkspaceError>;
  readonly exportPlan: (input: {
    readonly cwd: string;
    readonly markdown: string;
  }) => Effect.Effect<void, ArtifactWorkspaceError>;
  readonly watch: (cwd: string) => Stream.Stream<void, ArtifactWorkspaceError>;
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
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const ignoreSemaphore = yield* Semaphore.make(1);

    const runGit = Effect.fn("ArtifactWorkspace.runGit")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
      operation: string,
    ) {
      return yield* vcsProcess
        .run({
          operation,
          command: "git",
          args,
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 10_000,
          maxOutputBytes: 256 * 1024,
        })
        .pipe(
          Effect.mapError(
            workspaceError(operation, "Git could not prepare the artifacts directory."),
          ),
        );
    });

    const resolveWorkspace = Effect.fn("ArtifactWorkspace.resolveWorkspace")(function* (
      cwd: string,
    ) {
      const normalizedCwd = path.resolve(cwd);
      const cwdInfo = yield* fileSystem
        .stat(normalizedCwd)
        .pipe(
          Effect.mapError(
            workspaceError("resolve-workspace", "The project workspace is not available."),
          ),
        );
      if (cwdInfo.type !== "Directory") {
        return yield* new ArtifactWorkspaceError({
          operation: "resolve-workspace",
          detail: "The project workspace is not a directory.",
        });
      }

      const gitRoot = yield* runGit(
        normalizedCwd,
        ["rev-parse", "--show-toplevel"],
        "resolve-git-root",
      );
      const workspaceRoot =
        gitRoot.exitCode === 0 && gitRoot.stdout.trim().length > 0
          ? path.resolve(gitRoot.stdout.trim())
          : normalizedCwd;
      return {
        workspaceRoot,
        artifactRoot: path.join(workspaceRoot, ARTIFACT_DIRECTORY_NAME),
        git: gitRoot.exitCode === 0,
      };
    });

    const ensureIgnored = Effect.fn("ArtifactWorkspace.ensureIgnored")(function* (input: {
      readonly workspaceRoot: string;
      readonly artifactRoot: string;
      readonly git: boolean;
    }) {
      if (!input.git) return;

      yield* ignoreSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* runGit(
            input.workspaceRoot,
            ["ls-files", "--", ARTIFACT_DIRECTORY_NAME],
            "check-artifacts-tracked",
          );
          if (tracked.exitCode !== 0) {
            return yield* new ArtifactWorkspaceError({
              operation: "check-artifacts-tracked",
              detail: "Git could not verify whether artifacts are tracked.",
            });
          }
          if (tracked.stdout.trim().length > 0) {
            return yield* new ArtifactWorkspaceError({
              operation: "check-artifacts-tracked",
              detail:
                "The artifacts directory already contains tracked files. Untrack them before enabling automatic artifacts.",
            });
          }

          const gitPath = yield* runGit(
            input.workspaceRoot,
            ["rev-parse", "--git-path", "info/exclude"],
            "resolve-git-exclude",
          );
          if (gitPath.exitCode !== 0 || gitPath.stdout.trim().length === 0) {
            return yield* new ArtifactWorkspaceError({
              operation: "resolve-git-exclude",
              detail: "Git's local exclude file could not be resolved.",
            });
          }
          const excludePath = path.resolve(input.workspaceRoot, gitPath.stdout.trim());
          const current = yield* fileSystem.readFileString(excludePath).pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
            ),
            Effect.mapError(
              workspaceError("read-git-exclude", "Git's local exclude file could not be read."),
            ),
          );
          const hasPattern = current
            .split(/\r?\n/u)
            .some((line) => line.trim() === ARTIFACT_IGNORE_PATTERN);
          if (!hasPattern) {
            const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
            yield* fileSystem
              .writeFileString(excludePath, `${separator}${ARTIFACT_IGNORE_PATTERN}\n`, {
                flag: "a",
              })
              .pipe(
                Effect.mapError(
                  workspaceError(
                    "write-git-exclude",
                    "The artifacts directory could not be added to Git's local exclude file.",
                  ),
                ),
              );
          }

          yield* fileSystem
            .makeDirectory(input.artifactRoot, { recursive: true })
            .pipe(
              Effect.mapError(
                workspaceError("create-artifacts", "The artifacts directory could not be created."),
              ),
            );
          const ignored = yield* runGit(
            input.workspaceRoot,
            ["check-ignore", "--no-index", "--quiet", "--", ARTIFACT_DIRECTORY_NAME],
            "verify-artifacts-ignored",
          );
          if (ignored.exitCode !== 0) {
            return yield* new ArtifactWorkspaceError({
              operation: "verify-artifacts-ignored",
              detail:
                "Git still considers the artifacts directory visible. Check for a negating .gitignore rule before generating artifacts.",
            });
          }
        }),
      );
    });

    const resolveExistingArtifactRoot = Effect.fn("ArtifactWorkspace.resolveExistingArtifactRoot")(
      function* (cwd: string) {
        const workspace = yield* resolveWorkspace(cwd);
        const exists = yield* fileSystem
          .exists(workspace.artifactRoot)
          .pipe(
            Effect.mapError(
              workspaceError(
                "resolve-artifacts",
                "The artifacts directory could not be inspected.",
              ),
            ),
          );
        if (!exists) return { ...workspace, realArtifactRoot: null };
        const realArtifactRoot = yield* fileSystem
          .realPath(workspace.artifactRoot)
          .pipe(
            Effect.mapError(
              workspaceError("resolve-artifacts", "The artifacts directory could not be resolved."),
            ),
          );
        const realWorkspaceRoot = yield* fileSystem
          .realPath(workspace.workspaceRoot)
          .pipe(
            Effect.mapError(
              workspaceError("resolve-artifacts", "The project workspace could not be resolved."),
            ),
          );
        if (!isPathWithin(path, realWorkspaceRoot, realArtifactRoot)) {
          return yield* new ArtifactWorkspaceError({
            operation: "resolve-artifacts",
            detail: "The artifacts directory cannot be a link outside the project workspace.",
          });
        }
        return { ...workspace, realArtifactRoot };
      },
    );

    const prepare: ArtifactWorkspaceShape["prepare"] = Effect.fn("ArtifactWorkspace.prepare")(
      function* (cwd) {
        const workspace = yield* resolveWorkspace(cwd);
        yield* ensureIgnored(workspace);
        if (!workspace.git) {
          yield* fileSystem
            .makeDirectory(workspace.artifactRoot, { recursive: true })
            .pipe(
              Effect.mapError(
                workspaceError("create-artifacts", "The artifacts directory could not be created."),
              ),
            );
        }
      },
    );

    const list: ArtifactWorkspaceShape["list"] = Effect.fn("ArtifactWorkspace.list")(
      function* (cwd) {
        yield* prepare(cwd);
        const workspace = yield* resolveExistingArtifactRoot(cwd);
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
        const workspace = yield* resolveExistingArtifactRoot(input.cwd);
        if (workspace.realArtifactRoot === null) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "The artifact does not exist.",
          });
        }
        if (input.relativePath.trim().length === 0 || path.isAbsolute(input.relativePath)) {
          return yield* new ArtifactWorkspaceError({
            operation: "read-artifact",
            detail: "Artifact paths must be relative to the artifacts directory.",
          });
        }
        const requestedPath = path.resolve(workspace.realArtifactRoot, input.relativePath);
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
          path: input.relativePath.replaceAll("\\", "/"),
          byteLength: bytes.byteLength,
          encoding: binary ? "base64" : "utf8",
          content: binary ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes),
        } satisfies ArtifactContent;
      },
    );

    const exportPlan: ArtifactWorkspaceShape["exportPlan"] = Effect.fn(
      "ArtifactWorkspace.exportPlan",
    )(function* (input) {
      yield* prepare(input.cwd);
      const workspace = yield* resolveWorkspace(input.cwd);
      const realArtifactRoot = yield* fileSystem
        .realPath(workspace.artifactRoot)
        .pipe(
          Effect.mapError(
            workspaceError("resolve-artifacts", "The artifacts directory could not be resolved."),
          ),
        );
      const realWorkspaceRoot = yield* fileSystem
        .realPath(workspace.workspaceRoot)
        .pipe(
          Effect.mapError(
            workspaceError("resolve-artifacts", "The project workspace could not be resolved."),
          ),
        );
      if (!isPathWithin(path, realWorkspaceRoot, realArtifactRoot)) {
        return yield* new ArtifactWorkspaceError({
          operation: "resolve-artifacts",
          detail: "The artifacts directory cannot be a link outside the project workspace.",
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

    const watch: ArtifactWorkspaceShape["watch"] = (cwd) =>
      Stream.unwrap(
        resolveExistingArtifactRoot(cwd).pipe(
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

    return ArtifactWorkspace.of({ prepare, list, read, exportPlan, watch });
  }),
);

import * as NodeOS from "node:os";
import {
  HostProcessArchitecture,
  HostProcessPlatform,
  HostProcessEnvironment,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    bundleFormatVersion: Schema.Literal(2),
    bundleVersion: Schema.NonEmptyString,
    artifactToolVersion: Schema.NonEmptyString,
    targetPlatform: Schema.NonEmptyString,
    targetArch: Schema.NonEmptyString,
  }),
);

const decodeManifest = Schema.decodeUnknownEffect(Manifest);
const decodePackage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

export const WorkspaceDependencies = Schema.Struct({
  RUNTIME_NODE: Schema.String,
  RUNTIME_NODE_MODULES: Schema.String,
  RUNTIME_BIN_DIR: Schema.String,
  RUNTIME_PYTHON: Schema.String,
  bundleVersion: Schema.String,
  artifactToolVersion: Schema.String,
});

export class WorkspaceDependenciesError extends Schema.TaggedErrorClass<WorkspaceDependenciesError>()(
  "WorkspaceDependenciesError",
  { message: Schema.String },
) {}

// Desktop owns installation. J5 only discovers its existing bundle on the server
// host; neither a remote browser's filesystem nor a project-supplied path is used.
export const loadWorkspaceDependencies = Effect.fn("loadWorkspaceDependencies")(function* (
  configuredRoot?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const runtimeRoot =
    configuredRoot ??
    environment.J5CODE_PRIMARY_RUNTIME_DIR ??
    path.join(NodeOS.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime");
  const failure = (message: string) => new WorkspaceDependenciesError({ message });
  if (!path.isAbsolute(runtimeRoot))
    return yield* failure("J5CODE_PRIMARY_RUNTIME_DIR must be an absolute path.");
  const manifest = yield* decodeManifest(
    yield* fs.readFileString(path.join(runtimeRoot, "runtime.json")),
  );
  if (manifest.targetPlatform !== platform || manifest.targetArch !== architecture) {
    return yield* failure(
      `Runtime targets ${manifest.targetPlatform}/${manifest.targetArch}; server is ${platform}/${architecture}.`,
    );
  }
  const dependencies = path.join(runtimeRoot, "dependencies");
  const windows = platform === "win32";
  const result = {
    RUNTIME_NODE: path.join(dependencies, "node", ...(windows ? ["node.exe"] : ["bin", "node"])),
    RUNTIME_NODE_MODULES: path.join(dependencies, "node", "node_modules"),
    RUNTIME_BIN_DIR: path.join(dependencies, "bin", "override"),
    RUNTIME_PYTHON: path.join(
      dependencies,
      "python",
      ...(windows ? ["python.exe"] : ["bin", "python3"]),
    ),
    bundleVersion: manifest.bundleVersion,
    artifactToolVersion: manifest.artifactToolVersion,
  };
  for (const directory of [result.RUNTIME_NODE_MODULES, result.RUNTIME_BIN_DIR]) {
    if ((yield* fs.stat(directory)).type !== "Directory")
      return yield* failure(`Not a directory: ${directory}`);
  }
  for (const executable of [result.RUNTIME_NODE, result.RUNTIME_PYTHON]) {
    const info = yield* fs.stat(executable);
    if (info.type !== "File" || (!windows && (info.mode & 0o111) === 0))
      return yield* failure(`Not an executable file: ${executable}`);
    yield* fs.access(executable, { readable: true });
  }
  const artifactPackage = yield* decodePackage(
    yield* fs.readFileString(
      path.join(result.RUNTIME_NODE_MODULES, "@oai", "artifact-tool", "package.json"),
    ),
  );
  if (artifactPackage.version !== manifest.artifactToolVersion) {
    return yield* failure(
      "Artifact Tool version does not match runtime.json; the bundle is incomplete.",
    );
  }
  return result;
});

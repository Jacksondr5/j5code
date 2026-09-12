import {
  HostProcessArchitecture,
  HostProcessPlatform,
  HostProcessEnvironment,
} from "@t3tools/shared/hostProcess";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { loadWorkspaceDependencies } from "./WorkspaceDependencies.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const platform = HostProcessPlatform.defaultValue();
const architecture = HostProcessArchitecture.defaultValue();
const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HostProcessPlatform, platform),
  Layer.succeed(HostProcessArchitecture, architecture),
);
const manifest = {
  bundleFormatVersion: 2,
  bundleVersion: "test-bundle",
  artifactToolVersion: "2.8.59",
  targetPlatform: platform,
  targetArch: architecture,
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-runtime-test-" });
  const node = path.join(root, "dependencies/node", platform === "win32" ? "node.exe" : "bin/node");
  const python = path.join(
    root,
    "dependencies/python",
    platform === "win32" ? "python.exe" : "bin/python3",
  );
  for (const directory of [
    "dependencies/node/bin",
    "dependencies/python/bin",
    "dependencies/node/node_modules/@oai/artifact-tool",
    "dependencies/bin/override",
  ])
    yield* fs.makeDirectory(path.join(root, directory), { recursive: true });
  const manifestPath = path.join(root, "runtime.json");
  const packagePath = path.join(
    root,
    "dependencies/node/node_modules/@oai/artifact-tool/package.json",
  );
  yield* fs.writeFileString(manifestPath, encodeJson(manifest));
  for (const executable of [node, python]) {
    yield* fs.writeFileString(executable, "fixture");
    yield* fs.chmod(executable, 0o755);
  }
  yield* fs.writeFileString(packagePath, encodeJson({ version: manifest.artifactToolVersion }));
  return { fs, path, root, node, python, manifestPath, packagePath };
});
it.effect("returns validated bundle paths", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(yield* loadWorkspaceDependencies(f.root)).toEqual({
      RUNTIME_NODE: f.node,
      RUNTIME_PYTHON: f.python,
      RUNTIME_NODE_MODULES: f.path.join(f.root, "dependencies/node/node_modules"),
      RUNTIME_BIN_DIR: f.path.join(f.root, "dependencies/bin/override"),
      bundleVersion: manifest.bundleVersion,
      artifactToolVersion: manifest.artifactToolVersion,
    });
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
for (const key of ["targetPlatform", "targetArch", "bundleFormatVersion"] as const) {
  it.effect(`rejects an incompatible ${key}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.manifestPath,
        encodeJson({ ...manifest, [key]: key === "bundleFormatVersion" ? 999 : "unsupported" }),
      );
      expect((yield* loadWorkspaceDependencies(f.root).pipe(Effect.exit))._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
}
for (const missing of ["manifestPath", "python"] as const) {
  it.effect(`refuses a missing ${missing} instead of returning guessed paths`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.remove(f[missing]);
      expect((yield* loadWorkspaceDependencies(f.root).pipe(Effect.exit))._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
}
it.effect("refuses a mismatched package version", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.writeFileString(f.packagePath, encodeJson({ version: "0.0.0" }));
    const error = yield* loadWorkspaceDependencies(f.root).pipe(Effect.flip);
    expect(error.message).toContain("does not match");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
it.effect("rejects a relative configured path", () =>
  Effect.gen(function* () {
    const error = yield* loadWorkspaceDependencies("runtime").pipe(Effect.flip);
    expect(error.message).toContain("absolute path");
  }).pipe(Effect.provide(TestLayer)),
);
it.effect("refuses a directory in place of an executable", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.remove(f.node);
    yield* f.fs.makeDirectory(f.node);
    const error = yield* loadWorkspaceDependencies(f.root).pipe(Effect.flip);
    expect(error.message).toContain("Not an executable");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("uses the server runtime override when no explicit root is passed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const result = yield* loadWorkspaceDependencies().pipe(
      Effect.provideService(HostProcessEnvironment, { J5CODE_PRIMARY_RUNTIME_DIR: f.root }),
    );
    expect(result.RUNTIME_NODE).toBe(f.node);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

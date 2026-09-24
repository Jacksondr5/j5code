import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { layerTest as configLayerTest } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { layerTest as settingsLayerTest, ServerSettingsService } from "../../serverSettings.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import * as Installer from "./skillCatalogInstaller.ts";
import { makeSkillCatalogRpcHandlers } from "./skillCatalogRpc.ts";

vi.mock("./skillCatalogInstaller.ts", async (original) => ({
  ...(await original<typeof Installer>()),
}));
beforeEach(() => vi.stubEnv("CLAUDE_CONFIG_DIR", ""));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-catalog-rpc-" });
  const catalogDir = path.join(root, "catalog");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const skillFile = path.join(catalogDir, "skills", "explain", "SKILL.md");
  const contents = "---\ndescription: Explain clearly\n---\n";
  yield* fs.makeDirectory(path.dirname(skillFile), { recursive: true });
  yield* fs.writeFileString(skillFile, contents);
  yield* fs.writeFileString(
    path.join(catalogDir, "catalog.yaml"),
    "groups:\n  core:\n    description: Core\n    skills: [explain]\n",
  );
  const discovered = yield* Ref.make<ReadonlyArray<string>>([]);
  const refreshes = yield* Ref.make(0);
  const instanceId = ProviderInstanceId.make("codex");
  const providers = makeProviderRegistryMock([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      status: "ready",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      checkedAt: "2026-06-10T00:00:00.000Z",
      version: "1.0.0",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const layer = Layer.mergeAll(
    configLayerTest(root, stateDir),
    settingsLayerTest({
      skillCatalogSource: catalogDir,
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          environment: [
            { name: "HOME", value: homeDir },
            { name: "USERPROFILE", value: homeDir },
          ],
        },
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: { homePath: path.join(homeDir, ".claude") },
        },
      },
    }),
    Layer.succeed(ProviderRegistry, {
      ...providers,
      refreshInstance: (id) =>
        Effect.gen(function* () {
          assert.equal(id, instanceId);
          const dir = path.join(homeDir, ".agents", "skills");
          const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): string[] => []));
          const contents = yield* Effect.forEach(names, (name) =>
            fs.readFileString(path.join(dir, name, "SKILL.md")),
          );
          yield* Ref.set(discovered, contents);
          yield* Ref.update(refreshes, (n) => n + 1);
          return yield* providers.getProviders;
        }).pipe(Effect.orDie),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const { handlers, settings } = yield* Effect.gen(function* () {
    return {
      handlers: yield* makeSkillCatalogRpcHandlers({ observe: (_, effect) => effect }),
      settings: yield* ServerSettingsService,
    };
  }).pipe(Effect.provide(layer));
  return {
    fs,
    path,
    root,
    catalogDir,
    homeDir,
    skillFile,
    contents,
    discovered,
    refreshes,
    handlers,
    settings,
  };
});

describe("skill catalog RPC handlers", () => {
  it.effect("honors default enablement and legacy disabled flags for catalog destinations", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.settings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "HOME", value: f.homeDir, sensitive: false },
              { name: "USERPROFILE", value: f.homeDir, sensitive: false },
            ],
          },
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: { enabled: false, homePath: f.path.join(f.homeDir, ".claude") },
          },
        },
      });
      const result = yield* f.handlers["j5.skills.apply"]({
        expectedSource: f.catalogDir,
        groups: ["core"],
      });
      assert.equal(result.installed, 1);
      assert.isTrue(
        yield* f.fs.exists(f.path.join(f.homeDir, ".agents", "skills", "explain", "SKILL.md")),
      );
      assert.isFalse(yield* f.fs.exists(f.path.join(f.homeDir, ".claude", "skills", "explain")));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("rejects mismatched sources for status, apply and update", () =>
    Effect.gen(function* () {
      const { handlers, homeDir, fs } = yield* fixture;
      for (const operation of [
        handlers["j5.skills.status"]({ expectedSource: "other" }).pipe(Effect.asVoid),
        handlers["j5.skills.apply"]({ expectedSource: "other", groups: ["core"] }).pipe(
          Effect.asVoid,
        ),
        handlers["j5.skills.update"]({ expectedSource: "other" }).pipe(Effect.asVoid),
      ]) {
        const failure = yield* Effect.flip(operation);
        assert.equal(failure._tag, "SkillCatalogError");
        assert.match(failure.message, /source changed/i);
        if (failure._tag === "SkillCatalogError") assert.equal(failure.reason, "source-changed");
      }
      assert.isFalse(yield* fs.exists(homeDir));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reads a content-only catalog outside a Git repository", () =>
    Effect.gen(function* () {
      const { handlers, catalogDir } = yield* fixture;
      const result = yield* handlers["j5.skills.status"]({ expectedSource: catalogDir });
      assert.equal(result.catalogDir, catalogDir);
      assert.equal(result.groups[0]?.skills[0]?.description, "Explain clearly");
      assert.deepEqual(result.git, { upstream: null, dirty: false });
      assert.deepEqual(result.warnings, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refreshes actual installed skills after apply, removal and partial failure", () =>
    Effect.gen(function* () {
      const { handlers, catalogDir, discovered, refreshes, contents } = yield* fixture;
      const apply = (groups: string[]) =>
        handlers["j5.skills.apply"]({ expectedSource: catalogDir, groups });
      assert.equal((yield* apply(["core"])).installed, 2);
      assert.deepEqual(yield* Ref.get(discovered), [contents]);
      assert.equal((yield* apply([])).removed, 2);
      assert.deepEqual(yield* Ref.get(discovered), []);
      const originalApply = Installer.runApply;
      vi.spyOn(Installer, "runApply").mockImplementationOnce((input) =>
        originalApply(input, {
          verifyLinks: async () => {
            throw new Error("verification denied");
          },
        }),
      );
      const partial = yield* Effect.flip(apply(["core"]));
      assert.equal(partial._tag, "SkillCatalogError");
      if (partial._tag === "SkillCatalogError") assert.equal(partial.result?.installed, 2);
      assert.deepEqual(yield* Ref.get(discovered), [contents]);
      assert.equal(yield* Ref.get(refreshes), 3);
      yield* apply([]);
      assert.deepEqual(yield* Ref.get(discovered), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refreshes updated content through existing links after a real local Git pull", () =>
    Effect.gen(function* () {
      const { handlers, catalogDir, discovered, refreshes, contents, root, path, fs } =
        yield* fixture;
      const runner = yield* ProcessRunner.ProcessRunner;
      const git = (cwd: string, args: string[]) =>
        runner
          .run({
            command: "git",
            args: [
              "-c",
              "user.name=Catalog Test",
              "-c",
              "user.email=catalog@example.invalid",
              "-c",
              "commit.gpgsign=false",
              "-c",
              `core.hooksPath=${path.join(root, "no-hooks")}`,
              ...args,
            ],
            cwd,
          })
          .pipe(
            Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0, result.stderr))),
          );
      yield* git(catalogDir, ["init", "-b", "main"]);
      yield* git(catalogDir, ["add", "."]);
      yield* git(catalogDir, ["commit", "-m", "Initial catalog"]);
      const remote = path.join(root, "remote.git");
      yield* git(root, ["init", "--bare", remote]);
      yield* git(catalogDir, ["remote", "add", "origin", remote]);
      yield* git(catalogDir, ["push", "-u", "origin", "main"]);
      yield* handlers["j5.skills.apply"]({ expectedSource: catalogDir, groups: ["core"] });
      assert.deepEqual(yield* Ref.get(discovered), [contents]);
      const author = path.join(root, "author");
      yield* git(root, ["clone", "-b", "main", remote, author]);
      const updated = contents.replace("Explain clearly", "Updated explanation");
      yield* fs.writeFileString(path.join(author, "skills", "explain", "SKILL.md"), updated);
      yield* git(author, ["add", "."]);
      yield* git(author, ["commit", "-m", "Update description"]);
      yield* git(author, ["push"]);
      const result = yield* handlers["j5.skills.update"]({ expectedSource: catalogDir });
      assert.equal(result.upstream, "origin/main");
      assert.deepEqual(yield* Ref.get(discovered), [updated]);
      assert.equal(yield* Ref.get(refreshes), 2);
    }).pipe(
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
  );

  it.effect("refreshes providers after an update refusal", () =>
    Effect.gen(function* () {
      const { handlers, catalogDir, refreshes } = yield* fixture;
      const error = yield* Effect.flip(
        handlers["j5.skills.update"]({ expectedSource: catalogDir }),
      );
      assert.match(error.message, /Not a git checkout/);
      assert.equal(yield* Ref.get(refreshes), 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

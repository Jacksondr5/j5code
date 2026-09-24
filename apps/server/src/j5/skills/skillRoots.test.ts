import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { affectedSkillProviderIds, resolveSkillRoot } from "./skillRoots.ts";

describe("configured skill roots", () => {
  it.effect(
    "resolves each instance's home and Claude config without using the catalog directory",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = path.resolve("test-home");
        const environment = [
          { sensitive: false, name: "HOME", value: home },
          { sensitive: false, name: "USERPROFILE", value: home },
          { sensitive: false, name: "CLAUDE_CONFIG_DIR", value: "relative-claude" },
        ];
        const claude = {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          environment,
        };
        assert.equal(
          yield* resolveSkillRoot(claude, "user"),
          path.resolve("relative-claude", "skills"),
        );
        assert.equal(
          yield* resolveSkillRoot(
            { ...claude, config: { homePath: path.join(home, "work-claude") } },
            "user",
          ),
          path.join(home, "work-claude", "skills"),
        );
        const cleanEnv = environment.filter((entry) => entry.name !== "CLAUDE_CONFIG_DIR");
        assert.equal(
          yield* resolveSkillRoot(
            {
              ...claude,
              environment: [
                ...cleanEnv,
                { sensitive: false, name: "CLAUDE_CONFIG_DIR", value: "" },
              ],
            },
            "user",
          ),
          path.join(home, ".claude", "skills"),
        );
        assert.equal(
          yield* resolveSkillRoot(
            {
              ...claude,
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: path.join(home, "codex-profile") },
            },
            "user",
          ),
          path.join(home, ".agents", "skills"),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.effect("refreshes a shared Cursor root while leaving unrelated instance homes alone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const environment = [
      { sensitive: false, name: "HOME", value: home },
      { sensitive: false, name: "USERPROFILE", value: home },
    ];
    const codex = ProviderInstanceId.make("work-codex");
    const cursor = ProviderInstanceId.make("work-cursor");
    const claude = ProviderInstanceId.make("other-claude");
    const configurations = {
      [codex]: { driver: ProviderDriverKind.make("codex"), enabled: true, environment },
      [cursor]: { driver: ProviderDriverKind.make("cursor"), enabled: true, environment },
      [claude]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        config: { homePath: path.join(home, "other") },
      },
    };
    const snapshots: ServerProvider[] = Object.entries(configurations).map(([id, config]) => ({
      instanceId: ProviderInstanceId.make(id),
      driver: config.driver,
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-24T00:00:00Z",
      version: null,
      models: [],
      skills: [],
      slashCommands: [],
    }));
    assert.deepEqual(
      yield* affectedSkillProviderIds(snapshots, configurations, [
        path.join(home, ".agents", "skills"),
      ]),
      [codex, cursor],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

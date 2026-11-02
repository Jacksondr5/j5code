import { assert, it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";
import { resolveSkillRoot } from "../skills/skillRoots.ts";
import { seedLiveTestSkills } from "./liveTestSkills.ts";

const decodeInstance = Schema.decodeEffect(ProviderInstanceConfig);

it.effect("resolves both Skills write roots inside disposable homes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "j5-test-skills-" });
    const home = yield* fs.realPath(temporary);
    const settings = yield* seedLiveTestSkills(home);
    assert.deepEqual(Object.keys(settings.providerInstances), ["codex", "claudeAgent"]);
    for (const raw of Object.values(settings.providerInstances)) {
      const instance = yield* decodeInstance(raw);
      const root = yield* resolveSkillRoot(instance, "user");
      assert.equal(
        root,
        path.join(
          home,
          "test-skills",
          instance.driver,
          instance.driver === "codex" ? ".agents" : ".claude",
          "skills",
        ),
      );
      assert.equal(yield* fs.realPath(root), root);
      assert.ok(yield* fs.exists(path.join(root, "live-test-sample", "SKILL.md")));
    }
    const claude = settings.providerInstances.claudeAgent!;
    const skills = yield* discoverClaudeSkills(
      claude.config,
      home,
      Object.fromEntries(claude.environment.map((entry) => [entry.name, entry.value])),
    );
    assert.equal(skills.find((skill) => skill.name === "live-test-sample")?.scope, "user");
    assert.ok(yield* fs.exists(path.join(settings.skillCatalogSource, "catalog.yaml")));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

// @effect-diagnostics nodeBuiltinImport:off - verifies disposable fixture paths.
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveSkillRoot } from "../skills/skillRoots.ts";
import { seedLiveTestSkills } from "./liveTestSkills.ts";

const decodeInstance = Schema.decodeEffect(ProviderInstanceConfig);

it.effect("resolves both Skills write roots inside disposable homes", () =>
  Effect.gen(function* () {
    const home = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-test-skills-")),
    );
    try {
      const settings = seedLiveTestSkills(home);
      assert.deepEqual(Object.keys(settings.providerInstances), [
        "codex-test-skills",
        "claudeAgent-test-skills",
      ]);
      for (const raw of Object.values(settings.providerInstances)) {
        const instance = yield* decodeInstance(raw);
        const root = yield* resolveSkillRoot(instance, "user");
        assert.equal(
          root,
          NodePath.join(
            home,
            "test-skills",
            instance.driver,
            instance.driver === "codex" ? ".agents" : ".claude",
            "skills",
          ),
        );
        assert.equal(NodeFS.realpathSync(root), root);
        assert.ok(NodeFS.existsSync(NodePath.join(root, "live-test-sample", "SKILL.md")));
      }
      assert.ok(NodeFS.existsSync(NodePath.join(settings.skillCatalogSource, "catalog.yaml")));
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

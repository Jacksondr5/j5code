import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Disposable Skills instances; default instances retain the host's credentials. */
export const seedLiveTestSkills = Effect.fn("liveTest.seedSkills")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(home, "test-skills");
  const catalog = path.join(root, "catalog");
  const writeSkill = Effect.fn("liveTest.writeSampleSkill")(function* (directory: string) {
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, "SKILL.md"),
      "---\nname: live-test-sample\ndescription: A disposable live-test skill\n---\nReply with a short greeting.\n",
    );
  });
  yield* writeSkill(path.join(catalog, "skills", "live-test-sample"));
  yield* fs.writeFileString(
    path.join(catalog, "catalog.yaml"),
    "groups:\n  test:\n    description: Disposable test skills\n    skills: [live-test-sample]\n",
  );
  const instances = Object.fromEntries(
    yield* Effect.forEach(["codex", "claudeAgent"] as const, (driver) =>
      Effect.gen(function* () {
        const providerHome = path.join(root, driver);
        const configHome = path.join(providerHome, driver === "codex" ? ".codex" : ".claude");
        yield* fs.makeDirectory(configHome, { recursive: true });
        yield* writeSkill(
          path.join(
            providerHome,
            driver === "codex" ? ".agents" : ".claude",
            "skills",
            "live-test-sample",
          ),
        );
        return [
          `${driver}-test-skills`,
          {
            driver,
            displayName: `${driver === "codex" ? "Codex" : "Claude"} (test skills)`,
            enabled: true,
            config: { homePath: configHome },
            environment: Object.entries({
              HOME: providerHome,
              USERPROFILE: providerHome,
              CODEX_HOME: configHome,
              CLAUDE_CONFIG_DIR: configHome,
            }).map(([name, value]) => ({ name, value, sensitive: false })),
          },
        ] as const;
      }),
    ),
  );
  return { providerInstances: instances, skillCatalogSource: catalog };
});

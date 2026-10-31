import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Skills-only fixtures use loopback endpoints and no real account credentials. */
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
        if (driver === "codex") {
          yield* fs.writeFileString(
            path.join(configHome, "config.toml"),
            'model_provider = "live_test"\n[model_providers.live_test]\nname = "Live test (inventory only)"\nbase_url = "http://127.0.0.1:9/v1"\nrequires_openai_auth = false\n',
          );
        }
        yield* writeSkill(
          path.join(
            providerHome,
            driver === "codex" ? ".agents" : ".claude",
            "skills",
            "live-test-sample",
          ),
        );
        return [
          driver,
          {
            driver,
            displayName: `${driver === "codex" ? "Codex" : "Claude"} (test skills)`,
            enabled: true,
            config: { homePath: configHome },
            environment: Object.entries({
              HOME: providerHome,
              USERPROFILE: providerHome,
              CODEX_HOME: configHome,
              OPENAI_API_KEY: "",
              CODEX_API_KEY: "",
              CLAUDE_CONFIG_DIR: configHome,
              ...(driver === "claudeAgent"
                ? {
                    ANTHROPIC_API_KEY: "live-test-inventory-only",
                    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
                    CLAUDE_CODE_OAUTH_TOKEN: "",
                    ANTHROPIC_AUTH_TOKEN: "",
                    CLAUDE_CODE_USE_BEDROCK: "0",
                    CLAUDE_CODE_USE_VERTEX: "0",
                  }
                : {}),
            }).map(([name, value]) => ({ name, value, sensitive: false })),
          },
        ] as const;
      }),
    ),
  );
  return { providerInstances: instances, skillCatalogSource: catalog };
});

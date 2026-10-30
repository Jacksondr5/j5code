// @effect-diagnostics nodeBuiltinImport:off - build-time fixture writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Disposable Skills instances; default instances retain the host's credentials. */
export function seedLiveTestSkills(home: string) {
  const root = NodePath.join(home, "test-skills");
  const catalog = NodePath.join(root, "catalog");
  const writeSkill = (directory: string) => {
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(directory, "SKILL.md"),
      "---\nname: live-test-sample\ndescription: A disposable live-test skill\n---\nReply with a short greeting.\n",
    );
  };
  writeSkill(NodePath.join(catalog, "skills", "live-test-sample"));
  NodeFS.writeFileSync(
    NodePath.join(catalog, "catalog.yaml"),
    "groups:\n  test:\n    description: Disposable test skills\n    skills: [live-test-sample]\n",
  );
  const instances = Object.fromEntries(
    (["codex", "claudeAgent"] as const).map((driver) => {
      const providerHome = NodePath.join(root, driver);
      const configHome = NodePath.join(providerHome, driver === "codex" ? ".codex" : ".claude");
      NodeFS.mkdirSync(configHome, { recursive: true });
      writeSkill(
        NodePath.join(
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
      ];
    }),
  );
  return { providerInstances: instances, skillCatalogSource: catalog };
}

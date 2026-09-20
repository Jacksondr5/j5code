/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `<cwd>/.claude/skills` (project scope), one directory per skill with a
 * `SKILL.md` carrying YAML frontmatter. The user root wins on name collisions,
 * matching the CLI. `.agents/skills` is a Codex location: verified against the
 * CLI, a skill that lives only there is answered with `Unknown command`, so it
 * is not scanned here.
 * The Agent SDK init handshake surfaces skills only as slash commands without
 * their filesystem paths, so the provider snapshot scans the same locations
 * directly, mirroring how the Codex app-server reports its skills.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type ClaudeSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly name?: string;
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
    };

/**
 * Claude Code accepts the YAML 1.1 boolean spellings (`yes`/`no`, `on`/`off`,
 * `1`/`0`), which the 1.2 core schema this parser uses leaves as strings and
 * numbers. Verified against the CLI: a skill carrying `user-invocable: no` is
 * absent from its published slash commands, so a strict `=== false` here would
 * offer a command the CLI rejects.
 */
function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

export function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}),
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

/**
 * Where an administrator installs the policy file whose settings outrank every
 * user and project one. Absent on almost every machine, which is why a missing
 * file is the normal case rather than an error.
 */
export function claudeManagedSettingsPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = environment.PROGRAMDATA?.trim();
    return programData ? path.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Settings files Claude Code merges for `skillOverrides`, in increasing
 * precedence: user, project, project-local, then the administrator's managed
 * policy, which wins outright. When the workspace sits inside a git
 * repository, the repository root's `settings.local.json` is read too and
 * outranks the workspace's own local file. Verified against the CLI from a
 * nested cwd: a root local file switching a skill off wins over a cwd one
 * switching it on, the root's plain `settings.json` is not consulted, and
 * without a `.git` above the cwd no root file is read. A skill the user
 * switched off is reported disabled rather than dropped, so the picker can
 * grey it out instead of silently losing it.
 */
export function skillOverrideSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string> {
  const managedPath = claudeManagedSettingsPath(path, platform, environment);
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(managedPath ? [managedPath] : []),
  ];
}

/**
 * Nearest ancestor of `cwd` (inclusive) holding a `.git` entry, which is the
 * boundary Claude Code walks up to for project settings. `undefined` outside
 * a repository.
 */
const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const isRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isRoot) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
});

/**
 * The four states Claude Code accepts. The CLI validates the whole map, not
 * each entry: verified against it, one entry with an unknown value (or a
 * boolean) makes it drop every override in that file, so this schema does the
 * same rather than applying the valid siblings the CLI ignores.
 */
const SkillOverrideValue = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);

// Lenient because these settings files are hand-edited and Claude Code itself
// tolerates comments and trailing commas in them.
const SkillOverrideSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
  }),
);
const decodeSkillOverrideSettings = Schema.decodeUnknownEffect(SkillOverrideSettings);

/**
 * What a `skillOverrides` entry says about one skill. `"user-invocable-only"`
 * hides it from the agent exactly as `disable-model-invocation` does, so it is
 * kept apart from a plain on/off decision rather than collapsed into one.
 */
type SkillOverride = {
  readonly enabled: boolean;
  readonly userInvocationOnly: boolean;
};

function parseSkillOverride(value: typeof SkillOverrideValue.Type): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    case "on":
    case "name-only":
      return { enabled: true, userInvocationOnly: false };
  }
}

const readSkillOverrides = Effect.fn("readSkillOverrides")(function* (
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyMap<string, SkillOverride>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const overridesByName = new Map<string, SkillOverride>();
  const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);

  for (const settingsPath of skillOverrideSettingsPaths(
    path,
    configDirPath,
    cwd,
    platform,
    environment,
    repositoryRoot,
  )) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }

    const parsed = yield* decodeSkillOverrideSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring skillOverrides", {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    const overrides = parsed?.skillOverrides;
    if (!overrides) {
      continue;
    }

    for (const [name, value] of Object.entries(overrides)) {
      overridesByName.set(name, parseSkillOverride(value));
    }
  }

  return overridesByName;
});

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  const platform = yield* HostProcessPlatform;
  const userHome =
    (platform === "win32" ? environment.USERPROFILE : environment.HOME) || NodeOS.homedir();
  return path.resolve(cwd ?? process.cwd(), userHome, ".claude");
});

const PluginInstallation = Schema.Struct({
  scope: Schema.Literals(["user", "project", "local", "managed"]),
  installPath: Schema.NonEmptyString,
  projectPath: Schema.optional(Schema.NonEmptyString),
});
const PluginRegistry = Schema.Struct({
  version: Schema.Literal(2),
  plugins: Schema.Record(Schema.String, Schema.Unknown),
});
const PluginManifest = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
const PluginSettings = Schema.Struct({
  enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});

const decodePluginJson = Schema.decodeUnknownEffect(fromLenientJson(Schema.Unknown));
const decodePluginRegistry = Schema.decodeUnknownEffect(PluginRegistry);
const decodePluginInstallation = Schema.decodeUnknownEffect(PluginInstallation);
const decodePluginManifest = Schema.decodeUnknownEffect(PluginManifest);
const decodePluginSettings = Schema.decodeUnknownEffect(PluginSettings);

const readPluginJson = Effect.fn("readClaudePluginJson")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodePluginJson),
    Effect.orElseSucceed(() => undefined),
  );
});

// Claude Code identifies user, project, and plugin skills by directory, not
// frontmatter `name`. Plugins add their namespace: `compress/SKILL.md` with
// `name: caveman-compress` is `caveman:compress`. Ordinary skillOverrides also
// use directory names; plugin enablement is independent of those overrides.
const discoverClaudePluginSkills = Effect.fn("discoverClaudePluginSkills")(function* (
  configDir: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const registry = yield* readPluginJson(
    path.join(configDir, "plugins", "installed_plugins.json"),
  ).pipe(
    Effect.flatMap(decodePluginRegistry),
    Effect.orElseSucceed(() => undefined),
  );
  if (!registry) return [];

  // Plugin enablement is independent of ordinary skillOverrides. Read project
  // settings from the repository root down to the selected working directory.
  const repositoryRoot = cwd ? yield* findRepositoryRoot(cwd) : undefined;
  const projectDirs: string[] = [];
  if (cwd) {
    let directory = path.resolve(cwd);
    while (true) {
      projectDirs.unshift(directory);
      if (!repositoryRoot || directory === repositoryRoot) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const managed = claudeManagedSettingsPath(path, platform, environment);
  const enabledPlugins = new Map<string, boolean>();
  for (const file of [
    path.join(configDir, "settings.json"),
    ...projectDirs.flatMap((directory) => [
      path.join(directory, ".claude", "settings.json"),
      path.join(directory, ".claude", "settings.local.json"),
    ]),
    ...(managed ? [managed] : []),
  ]) {
    const settings = yield* readPluginJson(file).pipe(
      Effect.flatMap(decodePluginSettings),
      Effect.orElseSucceed(() => undefined),
    );
    for (const [id, enabled] of Object.entries(settings?.enabledPlugins ?? {})) {
      enabledPlugins.set(id, enabled);
    }
  }

  const skills: ServerProviderSkill[] = [];
  const scopePriority = { user: 0, project: 1, local: 2, managed: 3 };
  for (const [pluginId, entries] of Object.entries(registry.plugins)) {
    if (!pluginId.trim() || !Array.isArray(entries)) continue;
    const installations: Array<typeof PluginInstallation.Type> = [];
    for (const entry of entries) {
      const installation = yield* decodePluginInstallation(entry).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!installation || !path.isAbsolute(installation.installPath)) continue;
      if (installation.scope === "project" || installation.scope === "local") {
        if (!cwd || !installation.projectPath || !path.isAbsolute(installation.projectPath))
          continue;
        const relative = path.relative(installation.projectPath, path.resolve(cwd));
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          continue;
      }
      installations.push(installation);
    }
    const installation = installations.sort(
      (a, b) => scopePriority[b.scope] - scopePriority[a.scope],
    )[0];
    if (!installation) continue;
    const manifestPath = path.join(installation.installPath, ".claude-plugin", "plugin.json");
    const hasManifest = yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
    const manifest = hasManifest
      ? yield* readPluginJson(manifestPath).pipe(
          Effect.flatMap(decodePluginManifest),
          Effect.orElseSucceed(() => undefined),
        )
      : {};
    if (!manifest) continue;
    const namespace = manifest.name?.trim() || pluginId.split("@")[0];
    if (!namespace) continue;
    const declared =
      typeof manifest.skills === "string" ? [manifest.skills] : (manifest.skills ?? []);
    const roots = [path.join(installation.installPath, "skills")];
    for (const location of declared) {
      if (location !== "." && !location.startsWith("./")) continue;
      const root = path.resolve(installation.installPath, location);
      const relative = path.relative(installation.installPath, root);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        continue;
      roots.push(root);
    }
    if (
      manifest.skills === undefined &&
      !(yield* fs.exists(roots[0]!).pipe(Effect.orElseSucceed(() => false)))
    ) {
      roots.push(installation.installPath);
    }
    const seenFiles = new Set<string>();
    for (const root of new Set(roots)) {
      const directFile = path.join(root, "SKILL.md");
      const files = (yield* fs.exists(directFile).pipe(Effect.orElseSucceed(() => false)))
        ? [directFile]
        : (yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): string[] => [])))
            .sort()
            .map((entry) => path.join(root, entry, "SKILL.md"));
      for (const file of files) {
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);
        const contents = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
        if (contents === undefined) continue;
        const frontmatter = parseSkillFrontmatter(contents);
        if (frontmatter.kind === "malformed") continue;
        const name = path.basename(path.dirname(file));
        skills.push({
          name: `${namespace}:${name}`,
          path: file,
          pluginId,
          scope: installation.scope,
          enabled: enabledPlugins.get(pluginId) ?? false,
          ...(frontmatter.kind === "parsed" && frontmatter.description
            ? { description: frontmatter.description }
            : {}),
          ...(frontmatter.kind === "parsed" && frontmatter.userInvocationOnly
            ? { userInvocationOnly: true }
            : {}),
          ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
            ? { userInvocable: false }
            : {}),
        });
      }
    }
  }
  return skills;
});

/**
 * Enumerate Claude Code skills from the user config dir and the workspace
 * `.claude/skills`. Discovery is best-effort: unreadable roots and malformed
 * skill entries are skipped so a broken skill never degrades the provider
 * snapshot. Roots are listed highest precedence first and the first hit for a
 * name wins, matching Claude Code: verified against the CLI with the same
 * skill name in both scopes, the user copy is the one that runs. Reporting the
 * project copy instead would attach its invocation metadata to a command
 * Claude Code resolves elsewhere.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const skillOverrides = yield* readSkillOverrides(configDirPath, cwd, environment ?? process.env);

  const roots: ReadonlyArray<{ directory: string; scope: ClaudeSkillScope }> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".claude", "skills"), scope: "project" as const }] : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill won't load in Claude Code
      // either — skip it rather than surfacing a broken entry under its
      // directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const name = entry.trim();
      if (!name) {
        continue;
      }

      // First root wins, so a later root never displaces a higher-precedence
      // skill of the same name.
      if (skillsByName.has(name)) {
        continue;
      }

      const override = skillOverrides.get(name);
      const userInvocationOnly =
        (frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true) ||
        override?.userInvocationOnly === true;
      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: override?.enabled ?? true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
          ? { userInvocable: false }
          : {}),
      });
    }
  }

  const pluginSkills = yield* discoverClaudePluginSkills(
    configDirPath,
    cwd,
    environment ?? process.env,
  );
  return [...skillsByName.values(), ...pluginSkills].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - This boundary inspects links with lstat/readlink, including dangling links.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  SkillCatalogName,
  resolveSkillCatalogGroups,
  type SkillCatalogApplyInput,
  type SkillCatalogSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

const Catalog = Schema.Struct({
  groups: Schema.Record(
    SkillCatalogName,
    Schema.Struct({
      description: Schema.String,
      skills: Schema.Array(SkillCatalogName),
      depends: Schema.optional(Schema.Array(SkillCatalogName)),
    }),
  ),
});
const Selection = Schema.Struct({
  folder: Schema.String,
  groups: Schema.Array(SkillCatalogName),
});

const decodeSelection = Schema.decodeUnknownSync(Selection);
const decodeCatalog = Schema.decodeUnknownSync(Catalog);

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

function inside(root: string, target: string) {
  const path = NodePath.relative(root, target);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(path)
  );
}

/** User-wide selection: environments sharing an OS user manage the same installed links. */
export function createSkillCatalog(options: {
  platform: NodeJS.Platform;
  homeDirectory?: string;
  claudeConfigDirectory?: string;
}) {
  const home = options.homeDirectory ?? NodeOS.homedir();
  const expand = (path: string) =>
    path === "~" ? home : path.startsWith("~/") ? NodePath.join(home, path.slice(2)) : path;
  const targets = [
    NodePath.resolve(
      expand(
        options.claudeConfigDirectory ??
          process.env.CLAUDE_CONFIG_DIR ??
          NodePath.join(home, ".claude"),
      ),
      "skills",
    ),
    NodePath.join(home, ".agents", "skills"),
  ];
  const selectionFile = NodePath.join(home, ".agents", "skill-catalog.json");

  async function selection() {
    try {
      return decodeSelection(JSON.parse(await NodeFSP.readFile(selectionFile, "utf8")));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function read(folder?: string): Promise<SkillCatalogSnapshot> {
    const saved = await selection();
    const requested = folder === undefined ? saved?.folder : expand(folder.trim());
    if (!requested) return { folder: null, selectedGroups: [], groups: [], targets };
    if (!NodePath.isAbsolute(requested)) throw new Error("Choose an absolute catalog folder path.");
    const root = await NodeFSP.realpath(requested);
    const catalog = decodeCatalog(
      parse(await NodeFSP.readFile(NodePath.join(root, "catalog.yaml"), "utf8")),
    );
    const groups = Object.entries(catalog.groups).map(([id, group]) => ({
      id,
      description: group.description,
      skills: group.skills,
      depends: group.depends ?? [],
    }));
    resolveSkillCatalogGroups(
      groups,
      groups.map(({ id }) => id),
    );
    const seen = new Set<string>();
    for (const group of groups) {
      for (const name of group.skills) {
        if (seen.has(name)) throw new Error(`Skill belongs to more than one group: ${name}`);
        seen.add(name);
        if (!(await NodeFSP.stat(NodePath.join(root, "skills", name, "SKILL.md"))).isFile()) {
          throw new Error(`Missing skill entry point: ${name}/SKILL.md`);
        }
      }
    }
    return {
      folder: root,
      selectedGroups: saved?.folder === root ? saved.groups : [],
      groups,
      targets,
    };
  }

  async function apply(input: SkillCatalogApplyInput): Promise<SkillCatalogSnapshot> {
    const current = await read(input.folder);
    const root = current.folder!;
    const names = new Set(
      resolveSkillCatalogGroups(current.groups, input.groups).flatMap((group) => group.skills),
    );
    const previous = await selection();
    const ownedRoots = [
      NodePath.join(root, "skills"),
      ...(previous ? [NodePath.join(previous.folder, "skills")] : []),
    ];
    const removals: Array<{ path: string; destination: string }> = [];
    const additions: Array<{ path: string; destination: string }> = [];
    const collisions: string[] = [];
    const visited = new Set<string>();
    for (const target of targets) {
      await NodeFSP.mkdir(target, { recursive: true });
      const directory = await NodeFSP.realpath(target);
      if (visited.has(directory)) continue;
      visited.add(directory);
      const entries = new Set(await NodeFSP.readdir(directory));
      for (const name of new Set([...entries, ...names])) {
        const path = NodePath.join(directory, name);
        const desired = names.has(name) ? NodePath.join(root, "skills", name) : null;
        if (!entries.has(name)) {
          if (desired) additions.push({ path, destination: desired });
          continue;
        }
        const entry = await NodeFSP.lstat(path);
        const link = entry.isSymbolicLink() ? await NodeFSP.readlink(path) : null;
        const destination = link === null ? null : NodePath.resolve(NodePath.dirname(path), link);
        const ours = destination !== null && ownedRoots.some((owned) => inside(owned, destination));
        if (!ours) {
          if (desired) collisions.push(path);
          continue;
        }
        if (destination !== desired) {
          removals.push({ path, destination: link! });
          if (desired) additions.push({ path, destination: desired });
        }
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `Existing skills were left untouched. Resolve these name conflicts before applying:\n${collisions.join("\n")}`,
      );
    }
    for (const item of removals) {
      if ((await NodeFSP.readlink(item.path)) !== item.destination) {
        throw new Error(`Skill link changed while applying; retry: ${item.path}`);
      }
      await NodeFSP.unlink(item.path);
    }
    for (const item of additions) {
      await NodeFSP.symlink(
        item.destination,
        item.path,
        options.platform === "win32" ? "junction" : "dir",
      );
    }
    const temporary = await NodeFSP.mkdtemp(
      NodePath.join(NodePath.dirname(selectionFile), ".skill-catalog-"),
    );
    try {
      const staged = NodePath.join(temporary, "selection.json");
      await NodeFSP.writeFile(
        staged,
        JSON.stringify({ folder: root, groups: [...new Set(input.groups)].sort() }, null, 2) + "\n",
        { mode: 0o600 },
      );
      await NodeFSP.rename(staged, selectionFile);
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
    }
    return { ...current, selectedGroups: [...new Set(input.groups)].sort() };
  }

  return { read, apply };
}

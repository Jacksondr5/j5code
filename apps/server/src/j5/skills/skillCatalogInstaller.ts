// @effect-diagnostics nodeBuiltinImport:off - plain async installer needs lstat and Windows junctions; wrapped once at the tool boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  SkillCatalogApplyResult,
  SkillCatalogConflict,
  SkillCatalogFailedLink,
} from "@t3tools/contracts";
import { parse } from "yaml";

import { parseSkillFrontmatter } from "../../provider/Drivers/ClaudeSkills.ts";
import {
  canonicalSkillRoot,
  isMissing,
  linkDestination,
  readSkillsConcurrently,
  skillLinkIdentity,
  writeSkillStateAtomically,
} from "./skillFileSystem.ts";

// Native fs is intentional: ownership needs lstat, and Windows needs junctions.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

type CatalogGroup = {
  readonly description: string;
  readonly skills: ReadonlyArray<string>;
  readonly depends?: ReadonlyArray<string>;
};
export type Catalog = {
  readonly path: string;
  readonly dir: string;
  readonly groups: Readonly<Record<string, CatalogGroup>>;
};
type RecordedLink = { readonly path: string; readonly target: string };
export type CatalogState = {
  readonly folder: string | null;
  readonly groups: ReadonlyArray<string>;
  readonly links: ReadonlyArray<RecordedLink>;
};
type Link = { readonly skill: string; readonly linkPath: string; readonly target: string };
type Addition = Link & { readonly replace?: boolean; readonly previousTarget?: string };
export type Plan = {
  readonly additions: ReadonlyArray<Addition>;
  readonly removals: ReadonlyArray<Link>;
  readonly unchanged: ReadonlyArray<Link>;
  readonly conflicts: ReadonlyArray<SkillCatalogConflict>;
};
type ApplyPlanResult = {
  readonly applied: ReadonlyArray<
    Link & {
      readonly action: "added" | "removed";
      readonly previousTarget?: string;
      readonly identity?: string;
    }
  >;
  readonly failed: ReadonlyArray<SkillCatalogFailedLink>;
};

export function stateFilePath(homeDir: string) {
  return NodePath.join(homeDir, ".agents", "skill-catalog.json");
}

export function targetDirs(homeDir: string, env: NodeJS.ProcessEnv, catalogDir: string) {
  // The former CLI ran in the catalog directory, including for relative Claude config paths.
  const claudeBase = env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(homeDir, ".claude");
  return [
    ...new Set([
      NodePath.resolve(homeDir, ".agents", "skills"),
      NodePath.resolve(catalogDir, claudeBase, "skills"),
    ]),
  ];
}

export async function loadCatalog(catalogPath: string): Promise<Catalog> {
  const text = await NodeFSP.readFile(catalogPath, "utf8").catch((error: unknown) => {
    if (isMissing(error)) throw new Error(`No catalog.yaml in ${NodePath.dirname(catalogPath)}.`);
    throw error;
  });
  const data: unknown = parse(text);
  const groups = data && typeof data === "object" && "groups" in data ? data.groups : undefined;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) {
    throw new Error(`${catalogPath}: expected a "groups" map`);
  }
  const dir = NodePath.dirname(NodePath.resolve(catalogPath));
  for (const [name, value] of Object.entries(groups)) {
    const group = value as Record<string, unknown>;
    if (!NAME_PATTERN.test(name)) throw new Error(`Invalid group name: ${name}`);
    if (!group || typeof group !== "object" || Array.isArray(group))
      throw new Error(`Group ${name}: expected an object`);
    if (typeof group.description !== "string")
      throw new Error(`Group ${name}: missing description`);
    if (!Array.isArray(group.skills) || group.skills.length === 0) {
      throw new Error(`Group ${name}: expected a nonempty skills list`);
    }
    for (const skill of group.skills as unknown[]) {
      if (typeof skill !== "string" || !NAME_PATTERN.test(skill)) {
        throw new Error(`Group ${name}: invalid skill name: ${skill}`);
      }
    }
    if (group.depends !== undefined) {
      if (!Array.isArray(group.depends)) throw new Error(`Group ${name}: depends must be a list`);
      for (const dep of group.depends as unknown[]) {
        if (typeof dep !== "string" || !Object.hasOwn(groups, dep)) {
          throw new Error(`Group ${name}: unknown dependency: ${dep}`);
        }
      }
    }
  }
  // Every skill belongs to exactly one group.
  const validated = groups as Record<string, CatalogGroup>;
  const owner = new Map<string, string>();
  for (const [name, group] of Object.entries(validated)) {
    for (const skill of group.skills) {
      if (owner.has(skill)) {
        throw new Error(`Skill ${skill} is in groups ${owner.get(skill)} and ${name}`);
      }
      owner.set(skill, name);
    }
  }
  return { path: NodePath.resolve(catalogPath), dir, groups: validated };
}

export function resolveSelection(catalog: Catalog, selected: ReadonlyArray<string>) {
  const names = [...new Set(selected)];
  for (const name of names) {
    if (!Object.hasOwn(catalog.groups, name)) throw new Error(`Unknown group: ${name}`);
  }
  // Transitive dependencies, cycle-safe.
  const expanded: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string, stack: string[] = []) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Dependency cycle: ${[...stack, name].join(" -> ")}`);
    }
    visiting.add(name);
    for (const dep of catalog.groups[name]!.depends ?? []) visit(dep, [...stack, name]);
    visiting.delete(name);
    visited.add(name);
    expanded.push(name);
  };
  for (const name of names) visit(name);
  const skills = expanded.flatMap((name) => catalog.groups[name]!.skills);
  return { groups: expanded, skills };
}

export async function verifySkills(catalog: Catalog, skills: ReadonlyArray<string>) {
  const valid = await readSkillsConcurrently(skills, async (skill) => {
    try {
      const st = await NodeFSP.stat(NodePath.join(catalog.dir, "skills", skill, "SKILL.md"));
      return st.isFile();
    } catch {
      return false;
    }
  });
  const missing = skills.filter((_, index) => !valid[index]);
  if (missing.length > 0) {
    throw new Error(`Missing SKILL.md for: ${missing.join(", ")}`);
  }
}

export { linkDestination } from "./skillFileSystem.ts";

export async function planInstall({
  catalogDir,
  skills,
  dirs,
  recordedLinks,
}: {
  readonly catalogDir: string;
  readonly skills: ReadonlyArray<string>;
  readonly dirs: ReadonlyArray<string>;
  readonly recordedLinks: ReadonlyArray<RecordedLink>;
}): Promise<Plan> {
  const wanted = new Map(
    skills.map((skill) => [skill, NodePath.join(catalogDir, "skills", skill)]),
  );
  const recordedByPath = new Map(recordedLinks.map((link) => [link.path, link.target]));
  const additions: Addition[] = [];
  const removals: Link[] = [];
  const unchanged: Link[] = [];
  const conflicts: SkillCatalogConflict[] = [];
  const removalsByPath = new Set();

  const paths = [
    ...new Set(
      dirs.flatMap((dir) => [
        ...[...wanted.keys()].map((skill) => NodePath.join(dir, skill)),
        ...[...recordedByPath.keys()].filter(
          (linkPath) =>
            NodePath.dirname(linkPath) === dir && !wanted.has(linkPath.slice(dir.length + 1)),
        ),
      ]),
    ),
  ];
  const destinations = await readSkillsConcurrently(paths, linkDestination);
  const seenByPath = new Map(paths.map((path, index) => [path, destinations[index]!]));
  for (const dir of dirs) {
    for (const [skill, target] of wanted) {
      const linkPath = NodePath.join(dir, skill);
      const seen = seenByPath.get(linkPath)!;
      if (seen.kind === "absent") {
        additions.push({ skill, linkPath, target });
      } else if (seen.kind === "link" && seen.target === target) {
        unchanged.push({ skill, linkPath, target });
      } else if (seen.kind === "link" && recordedByPath.get(linkPath) === seen.target) {
        // Owned link pointing elsewhere (catalog moved or skill renamed): replace.
        additions.push({ skill, linkPath, target, replace: true, previousTarget: seen.target });
      } else {
        conflicts.push({
          skill,
          linkPath,
          detail: seen.kind === "link" ? `points at ${seen.raw}` : `existing ${seen.kind}`,
        });
      }
    }
    // Owned links whose skill is no longer wanted.
    for (const [linkPath, target] of recordedByPath) {
      if (NodePath.dirname(linkPath) !== dir) continue;
      const skill = linkPath.slice(dir.length + 1);
      if (wanted.has(skill) || removalsByPath.has(linkPath)) continue;
      const seen = seenByPath.get(linkPath)!;
      if (seen.kind === "link" && seen.target === target) {
        removals.push({ skill, linkPath, target });
        removalsByPath.add(linkPath);
      } else if (seen.kind === "absent") {
        removalsByPath.add(linkPath);
      }
      // Foreign or changed entries are left alone (reported as conflicts only when wanted).
    }
  }
  return { additions, removals, unchanged, conflicts };
}

export async function applyPlan(
  { additions, removals }: Pick<Plan, "additions" | "removals">,
  { windows }: { readonly windows: boolean },
): Promise<ApplyPlanResult> {
  const applied: Array<ApplyPlanResult["applied"][number]> = [];
  const failed: SkillCatalogFailedLink[] = [];
  const type = windows ? "junction" : "dir";
  const remove = async (entry: Link, expectedTarget: string) => {
    const seen = await linkDestination(entry.linkPath);
    if (seen.kind === "absent") return "gone";
    if (seen.kind !== "link" || seen.target !== expectedTarget) {
      throw new Error(`${entry.linkPath} changed since inspection; stopping`);
    }
    await NodeFSP.unlink(entry.linkPath);
    return "removed";
  };
  for (const entry of removals) {
    try {
      await remove(entry, entry.target);
      applied.push({ ...entry, action: "removed" });
    } catch (error) {
      failed.push({ linkPath: entry.linkPath, error: errorMessage(error) });
      return { applied, failed };
    }
  }
  for (const entry of additions) {
    // Replacement entries are removed (old target) and recreated (new target)
    // as one unit, so an unrelated later failure cannot orphan an earlier removal.
    try {
      if (entry.replace) {
        await remove(entry, entry.previousTarget ?? entry.target);
        applied.push({ ...entry, action: "removed" });
      }
      const seen = await linkDestination(entry.linkPath);
      if (seen.kind !== "absent") {
        throw new Error(`${entry.linkPath} changed since inspection; stopping`);
      }
      await NodeFSP.mkdir(NodePath.dirname(entry.linkPath), { recursive: true });
      await NodeFSP.symlink(entry.target, entry.linkPath, type);
      const added: Link & { action: "added"; identity?: string } = { ...entry, action: "added" };
      applied.push(added);
      added.identity = await skillLinkIdentity(entry.linkPath);
    } catch (error) {
      failed.push({ linkPath: entry.linkPath, error: errorMessage(error) });
      return { applied, failed };
    }
  }
  return { applied, failed };
}

async function rollbackApply(result: ApplyPlanResult, windows: boolean) {
  const remaining = new Set(result.applied);
  const failures: SkillCatalogFailedLink[] = [];
  for (const entry of result.applied.toReversed()) {
    try {
      const seen = await linkDestination(entry.linkPath);
      if (entry.action === "added") {
        if (
          seen.kind !== "link" ||
          seen.target !== entry.target ||
          !entry.identity ||
          (await skillLinkIdentity(entry.linkPath)) !== entry.identity
        )
          throw new Error("Created link changed before rollback; remove it manually.");
        await NodeFSP.unlink(entry.linkPath);
      } else {
        if (seen.kind !== "absent")
          throw new Error("Destination is occupied; restore the previous link manually.");
        await NodeFSP.symlink(
          entry.previousTarget ?? entry.target,
          entry.linkPath,
          windows ? "junction" : "dir",
        );
      }
      remaining.delete(entry);
    } catch (error) {
      failures.push({ linkPath: entry.linkPath, error: `rollback failed: ${errorMessage(error)}` });
    }
  }
  return { applied: result.applied.filter((entry) => remaining.has(entry)), failed: failures };
}

export async function verifyLinks(entries: ReadonlyArray<Link>) {
  const seen = await readSkillsConcurrently(entries, (entry) => linkDestination(entry.linkPath));
  return entries.flatMap((entry, index) =>
    seen[index]!.kind !== "link" || seen[index]!.target !== entry.target ? [entry.linkPath] : [],
  );
}

export async function loadState(homeDir: string): Promise<CatalogState> {
  let text: string;
  try {
    text = await NodeFSP.readFile(stateFilePath(homeDir), "utf8");
  } catch (error) {
    if (isMissing(error)) return { folder: null, groups: [], links: [] };
    throw error;
  }
  // Syntax errors must leave the ownership file intact, rather than resetting it on Apply.
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { folder: null, groups: [], links: [] };
  }
  const data = parsed as Record<string, unknown>;
  const folder = typeof data.folder === "string" ? data.folder : null;
  const links: RecordedLink[] = [];
  for (const link of (Array.isArray(data.links) ? data.links : []) as unknown[]) {
    if (
      !link ||
      typeof link !== "object" ||
      !("path" in link) ||
      !("target" in link) ||
      typeof link.path !== "string" ||
      typeof link.target !== "string"
    )
      continue;
    let path = link.path;
    if (!NodePath.isAbsolute(path)) {
      if (!folder || !NodePath.isAbsolute(folder)) {
        throw new Error(
          `Cannot resolve relative owned link ${path}: saved catalog folder is not absolute.`,
        );
      }
      path = NodePath.resolve(folder, path);
    }
    links.push({ path, target: link.target });
  }
  return {
    folder,
    groups: Array.isArray(data.groups)
      ? (data.groups as unknown[]).filter((g): g is string => typeof g === "string")
      : [],
    links,
  };
}

export async function saveState(homeDir: string, state: CatalogState) {
  await writeSkillStateAtomically(stateFilePath(homeDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function reconcileLinks({
  result,
  previousLinks,
}: {
  readonly result: ApplyPlanResult;
  readonly previousLinks: ReadonlyArray<RecordedLink>;
}) {
  const kept = new Map(previousLinks.map((link) => [link.path, link.target]));
  // A matching link absent from saved ownership remains external.
  for (const entry of result.applied) {
    if (entry.action === "added") kept.set(entry.linkPath, entry.target);
    else kept.delete(entry.linkPath);
  }
  return [...kept].map(([path, target]) => ({ path, target }));
}

export class IncompleteApplyError extends Error {
  readonly result: SkillCatalogApplyResult;

  constructor(message: string, result: SkillCatalogApplyResult) {
    super(message);
    this.name = "IncompleteApplyError";
    this.result = result;
  }
}

export function toApplyResult({
  explicitGroups,
  plan,
  result,
  failed,
}: {
  readonly explicitGroups: ReadonlyArray<string>;
  readonly plan: Plan;
  readonly result: ApplyPlanResult;
  readonly failed: ReadonlyArray<SkillCatalogFailedLink>;
}): SkillCatalogApplyResult {
  const addedByPath = new Set(
    result.applied.filter((e) => e.action === "added").map((e) => e.linkPath),
  );
  return {
    selectedGroups: explicitGroups,
    installed: result.applied.filter((e) => e.action === "added").length,
    // Every actual removal counts, including replacement removals whose
    // recreation never succeeded. A replaced link (removed + added at the
    // same path) counts as installed, not as removed.
    removed: result.applied.filter((e) => e.action === "removed" && !addedByPath.has(e.linkPath))
      .length,
    unchanged: plan.unchanged.length,
    conflicts: plan.conflicts.map((c) => ({
      skill: c.skill,
      linkPath: c.linkPath,
      detail: c.detail,
    })),
    failed,
  };
}

// Shared Apply: resolution, verification, planning (recomputed inside), applying,
// link verification, ownership reconciliation, state saving, normalized results.
// Throws IncompleteApplyError with partial `.result` when execution, verification,
// or state persistence fails after mutation may have occurred.
export async function runApply(
  {
    catalog,
    catalogDir,
    homeDir,
    state,
    selected,
    windows,
  }: {
    readonly catalog: Catalog;
    readonly catalogDir: string;
    readonly homeDir: string;
    readonly state: CatalogState;
    readonly selected: ReadonlyArray<string>;
    readonly windows: boolean;
  },
  opts: { readonly verifyLinks?: typeof verifyLinks } = {},
): Promise<SkillCatalogApplyResult> {
  const explicitGroups = [...new Set(selected)];
  const resolved = resolveSelection(catalog, explicitGroups);
  await verifySkills(catalog, resolved.skills);
  const dirs = [
    ...new Set(
      await readSkillsConcurrently(
        targetDirs(homeDir, process.env, catalogDir),
        canonicalSkillRoot,
      ),
    ),
  ];
  const savedPaths = await readSkillsConcurrently(state.links, async (link) =>
    NodePath.join(
      await canonicalSkillRoot(NodePath.dirname(link.path)),
      NodePath.basename(link.path),
    ),
  );
  const recorded = new Map<string, string>();
  for (const [index, link] of state.links.entries()) {
    const path = savedPaths[index]!;
    const previous = recorded.get(path);
    if (previous !== undefined && previous !== link.target)
      throw new Error(`Conflicting saved ownership for ${path}; repair the state before applying.`);
    recorded.set(path, link.target);
  }
  const canonicalState = {
    ...state,
    links: [...recorded].map(([path, target]) => ({ path, target })),
  };
  const plan = await planInstall({
    catalogDir,
    skills: resolved.skills,
    dirs,
    recordedLinks: canonicalState.links,
  });
  const result = await applyPlan(plan, { windows });
  const failed = result.failed.map((f) => ({ linkPath: f.linkPath, error: f.error }));
  // A throwing verifier must not discard the operation result: record it as a
  // failure entry so counts are preserved and ownership is saved below.
  const ownedBefore = new Map(canonicalState.links.map((link) => [link.path, link.target]));
  let verified = null;
  try {
    verified = await (opts.verifyLinks ?? verifyLinks)([
      ...plan.unchanged.filter((entry) => ownedBefore.get(entry.linkPath) === entry.target),
      ...result.applied.filter((e) => e.action === "added"),
    ]);
  } catch (error) {
    failed.push({
      linkPath: "(verification)",
      error: `verification failed: ${errorMessage(error)}`,
    });
  }
  if (verified) {
    for (const linkPath of verified) {
      failed.push({ linkPath, error: "link not verified after apply" });
    }
  }
  const links = reconcileLinks({
    result,
    previousLinks: canonicalState.links,
  });
  const output = toApplyResult({ explicitGroups, plan, result, failed });
  // Save ownership before reporting failures so retry can recover.
  try {
    await saveState(homeDir, { folder: catalogDir, groups: explicitGroups, links });
  } catch (error) {
    const rollback = await rollbackApply(result, windows);
    const recovered = toApplyResult({
      explicitGroups,
      plan,
      result: { applied: rollback.applied, failed: [] },
      failed: [...failed, ...rollback.failed],
    });
    throw new IncompleteApplyError(
      `Incomplete: state save failed: ${errorMessage(error)}. ${rollback.failed.length ? "Rollback incomplete; clean up the listed paths before retrying." : "Filesystem changes rolled back; retry Apply."}`,
      recovered,
    );
  }
  if (failed.length > 0) {
    const details = failed.map((f) => `${f.linkPath}: ${f.error}`).join("; ");
    throw new IncompleteApplyError(`Incomplete: ${details}. Retry to recover.`, output);
  }
  return output;
}

export async function skillDescription(catalogDir: string, skill: string) {
  try {
    const text = await NodeFSP.readFile(
      NodePath.join(catalogDir, "skills", skill, "SKILL.md"),
      "utf8",
    );
    const front = parseSkillFrontmatter(text);
    return front.kind === "parsed" ? (front.description ?? "").replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  }
}

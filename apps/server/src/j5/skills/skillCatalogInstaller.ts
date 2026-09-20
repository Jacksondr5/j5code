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

// Native fs is intentional: ownership needs lstat, and Windows needs junctions.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

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
  readonly applied: ReadonlyArray<Link & { readonly action: "added" | "removed" }>;
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
  const missing = [];
  for (const skill of skills) {
    try {
      const st = await NodeFSP.lstat(NodePath.join(catalog.dir, "skills", skill, "SKILL.md"));
      if (!st.isFile() && !st.isSymbolicLink()) missing.push(skill);
    } catch {
      missing.push(skill);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing SKILL.md for: ${missing.join(", ")}`);
  }
}

export async function linkDestination(linkPath: string) {
  // Resolve relative symlink targets before comparing ownership.
  let st;
  try {
    st = await NodeFSP.lstat(linkPath);
  } catch (error) {
    if (isMissing(error)) return { kind: "absent" } as const;
    throw error;
  }
  if (!st.isSymbolicLink()) {
    return { kind: st.isDirectory() ? "directory" : "other" } as const;
  }
  const raw = await NodeFSP.readlink(linkPath);
  return { kind: "link", raw, target: NodePath.resolve(NodePath.dirname(linkPath), raw) } as const;
}

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

  for (const dir of dirs) {
    for (const [skill, target] of wanted) {
      const linkPath = NodePath.join(dir, skill);
      const seen = await linkDestination(linkPath);
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
      const seen = await linkDestination(linkPath);
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
  const applied: Array<Link & { action: "added" | "removed" }> = [];
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
      applied.push({ ...entry, action: "added" });
    } catch (error) {
      failed.push({ linkPath: entry.linkPath, error: errorMessage(error) });
      return { applied, failed };
    }
  }
  return { applied, failed };
}

export async function verifyLinks(entries: ReadonlyArray<Link>) {
  const bad = [];
  for (const entry of entries) {
    const seen = await linkDestination(entry.linkPath);
    if (seen.kind !== "link" || seen.target !== entry.target) bad.push(entry.linkPath);
  }
  return bad;
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
  const file = stateFilePath(homeDir);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const staging = NodePath.join(NodePath.dirname(file), `.skill-catalog.${process.pid}.tmp`);
  await NodeFSP.writeFile(staging, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await NodeFSP.rename(staging, file);
}

export function reconcileLinks({
  plan,
  result,
  previousLinks,
}: {
  readonly plan: Plan;
  readonly result: ApplyPlanResult;
  readonly previousLinks: ReadonlyArray<RecordedLink>;
}) {
  // Links actually present after apply. A successful addition at a path takes
  // precedence over an earlier removal at that same path (replacement).
  const addedByPath = new Map<string, string>();
  for (const e of result.applied) {
    if (e.action === "added") addedByPath.set(e.linkPath, e.target);
  }
  const removedPaths = new Set();
  for (const e of result.applied) {
    if (e.action === "removed" && !addedByPath.has(e.linkPath)) removedPaths.add(e.linkPath);
  }
  const unchangedByPath = new Map(plan.unchanged.map((e) => [e.linkPath, e.target]));
  const kept = new Map<string, string>();
  for (const e of [...plan.unchanged, ...plan.additions]) {
    if (addedByPath.has(e.linkPath)) {
      kept.set(e.linkPath, addedByPath.get(e.linkPath)!);
    } else if (removedPaths.has(e.linkPath)) {
      continue;
    } else if (unchangedByPath.has(e.linkPath)) {
      kept.set(e.linkPath, unchangedByPath.get(e.linkPath)!);
    }
    // Planned additions that were never applied (failure, early return) are not kept.
  }
  // Retain previously recorded links we did not touch (partial failure safety).
  // If removal succeeded but creation failed, the path is in removedPaths and the
  // nonexistent link is not retained. If removal failed, the old owned link remains
  // and its ownership is retained for recovery. Foreign entries remain untouched.
  for (const link of previousLinks) {
    if (!kept.has(link.path) && !removedPaths.has(link.path)) kept.set(link.path, link.target);
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
  const dirs = targetDirs(homeDir, process.env, catalogDir);
  const plan = await planInstall({
    catalogDir,
    skills: resolved.skills,
    dirs,
    recordedLinks: state.links,
  });
  const result = await applyPlan(plan, { windows });
  const failed = result.failed.map((f) => ({ linkPath: f.linkPath, error: f.error }));
  // A throwing verifier must not discard the operation result: record it as a
  // failure entry so counts are preserved and ownership is saved below.
  let verified = null;
  try {
    verified = await (opts.verifyLinks ?? verifyLinks)([
      ...plan.unchanged,
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
    plan,
    result,
    previousLinks: state.links,
  });
  const output = toApplyResult({ explicitGroups, plan, result, failed });
  // Save ownership before reporting failures so retry can recover.
  try {
    await saveState(homeDir, { folder: catalogDir, groups: explicitGroups, links });
  } catch (error) {
    throw new IncompleteApplyError(
      `Incomplete: state save failed${failed.length > 0 ? " after partial apply" : ""}: ${errorMessage(error)}`,
      output,
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

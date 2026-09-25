// @effect-diagnostics nodeBuiltinImport:off - plain async installer needs lstat and Windows junctions; wrapped once at the tool boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  SkillCatalogApplyResult,
  SkillCatalogConflict,
  SkillCatalogFailedLink,
  SkillCatalogReplacement,
} from "@t3tools/contracts";
import { parse } from "yaml";
import * as Schema from "effect/Schema";

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

const CatalogName = Schema.String.check(Schema.isPattern(NAME_PATTERN));
const CatalogGroup = Schema.Struct({
  description: Schema.String,
  skills: Schema.Array(CatalogName).check(Schema.isMinLength(1)),
  depends: Schema.optional(Schema.Array(CatalogName)),
});
const CatalogDocument = Schema.Struct({ groups: Schema.Record(Schema.String, CatalogGroup) });
export type Catalog = {
  readonly path: string;
  readonly dir: string;
  readonly groups: (typeof CatalogDocument.Type)["groups"];
};
const RecordedLink = Schema.Struct({ path: Schema.String, target: Schema.String });
type RecordedLink = typeof RecordedLink.Type;
const CatalogState = Schema.Struct({
  folder: Schema.NullOr(Schema.String),
  groups: Schema.Array(Schema.String),
  links: Schema.Array(RecordedLink),
});
export type CatalogState = typeof CatalogState.Type;
const decodeCatalog = Schema.decodeUnknownSync(CatalogDocument, { onExcessProperty: "error" });
const decodeName = Schema.decodeUnknownSync(CatalogName);
const decodeState = Schema.decodeUnknownSync(CatalogState);
type Link = { readonly skill: string; readonly linkPath: string; readonly target: string };
type Addition = Link & {
  readonly replace?: boolean;
  readonly previousTarget?: string;
  readonly previousIdentity?: string;
};
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

export function stateFilePath(stateDir: string) {
  return NodePath.join(stateDir, "skill-catalog.json");
}

export async function loadCatalog(catalogPath: string): Promise<Catalog> {
  const text = await NodeFSP.readFile(catalogPath, "utf8").catch((error: unknown) => {
    if (isMissing(error)) throw new Error(`No catalog.yaml in ${NodePath.dirname(catalogPath)}.`);
    throw error;
  });
  const { groups } = decodeCatalog(parse(text));
  const dir = NodePath.dirname(NodePath.resolve(catalogPath));
  for (const [name, group] of Object.entries(groups)) {
    decodeName(name);
    for (const dep of group.depends ?? []) {
      if (!Object.hasOwn(groups, dep)) throw new Error(`Group ${name}: unknown dependency: ${dep}`);
    }
  }
  // Every skill belongs to exactly one group.
  const owner = new Map<string, string>();
  for (const [name, group] of Object.entries(groups)) {
    for (const skill of group.skills) {
      if (owner.has(skill)) {
        throw new Error(`Skill ${skill} is in groups ${owner.get(skill)} and ${name}`);
      }
      owner.set(skill, name);
    }
  }
  return { path: NodePath.resolve(catalogPath), dir, groups };
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
  const removalsByPath = new Set<string>();

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
        let replacement: SkillCatalogReplacement | undefined;
        if (seen.kind === "link") {
          const identity = await skillLinkIdentity(linkPath);
          const current = await linkDestination(linkPath);
          if (current.kind === "link" && current.target === seen.target) {
            replacement = { linkPath, currentTarget: seen.target, target, identity };
          }
        }
        conflicts.push({
          skill,
          linkPath,
          ...(replacement ? { replacement } : {}),
          detail:
            seen.kind === "link"
              ? `Already linked to ${seen.raw}. The link was left unchanged. Review and confirm replacement to use this catalog.`
              : `An existing ${seen.kind} occupies this path and was left unchanged.`,
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
  const remove = async (entry: Link, expectedTarget: string, expectedIdentity?: string) => {
    const seen = await linkDestination(entry.linkPath);
    if (seen.kind === "absent" && !expectedIdentity) return "gone";
    if (
      seen.kind !== "link" ||
      seen.target !== expectedTarget ||
      (expectedIdentity !== undefined &&
        (await skillLinkIdentity(entry.linkPath)) !== expectedIdentity)
    ) {
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
        await remove(entry, entry.previousTarget ?? entry.target, entry.previousIdentity);
        applied.push({ ...entry, action: "removed" });
      }
      const seen = await linkDestination(entry.linkPath);
      if (seen.kind !== "absent") {
        throw new Error(`${entry.linkPath} changed since inspection; stopping`);
      }
      await NodeFSP.mkdir(NodePath.dirname(entry.linkPath), { recursive: true });
      await NodeFSP.symlink(entry.target, entry.linkPath, type);
      const added: Link & { action: "added"; identity?: string } = { ...entry, action: "added" };
      try {
        added.identity = await skillLinkIdentity(entry.linkPath);
      } catch (error) {
        const created = await linkDestination(entry.linkPath);
        if (created.kind === "link" && created.target === entry.target)
          await NodeFSP.unlink(entry.linkPath);
        throw error;
      }
      applied.push(added);
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

export async function loadState(stateDir: string): Promise<CatalogState> {
  let text: string;
  try {
    text = await NodeFSP.readFile(stateFilePath(stateDir), "utf8");
  } catch (error) {
    if (isMissing(error)) return { folder: null, groups: [], links: [] };
    throw error;
  }
  // Syntax errors must leave the ownership file intact, rather than resetting it on Apply.
  const data = decodeState(JSON.parse(text));
  const { folder } = data;
  const links = data.links.map((link) => {
    if (NodePath.isAbsolute(link.path)) return link;
    if (!folder || !NodePath.isAbsolute(folder)) {
      throw new Error(
        `Cannot resolve relative owned link ${link.path}: saved catalog folder is not absolute.`,
      );
    }
    return { ...link, path: NodePath.resolve(folder, link.path) };
  });
  return {
    folder,
    groups: data.groups,
    links,
  };
}

export async function saveState(stateDir: string, state: CatalogState) {
  await writeSkillStateAtomically(stateFilePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
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
    conflicts: plan.conflicts,
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
    stateDir,
    targets,
    state,
    selected,
    windows,
    replacements = [],
  }: {
    readonly catalog: Catalog;
    readonly catalogDir: string;
    readonly stateDir: string;
    readonly targets: ReadonlyArray<string>;
    readonly state: CatalogState;
    readonly selected: ReadonlyArray<string>;
    readonly windows: boolean;
    readonly replacements?: ReadonlyArray<SkillCatalogReplacement>;
  },
  opts: { readonly verifyLinks?: typeof verifyLinks } = {},
): Promise<SkillCatalogApplyResult> {
  const explicitGroups = [...new Set(selected)];
  if (
    replacements.length > 0 &&
    (state.folder !== catalogDir ||
      state.groups.length !== explicitGroups.length ||
      !state.groups.every((group) => explicitGroups.includes(group)))
  ) {
    throw new Error(
      "Catalog selection changed since preview. Apply selected groups again to review current conflicts.",
    );
  }
  const resolved = resolveSelection(catalog, explicitGroups);
  await verifySkills(catalog, resolved.skills);
  const dirs = [...new Set(await readSkillsConcurrently(targets, canonicalSkillRoot))];
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
  // Validate every confirmation against a fresh plan before any filesystem mutation.
  const confirmed = new Set<string>();
  // A replacement confirmation changes only the selected links, not new group changes.
  const additions: Addition[] = replacements.length > 0 ? [] : [...plan.additions];
  for (const replacement of replacements) {
    const conflict = plan.conflicts.find((entry) => entry.linkPath === replacement.linkPath);
    const current = conflict?.replacement;
    if (
      confirmed.has(replacement.linkPath) ||
      !conflict ||
      !current ||
      current.currentTarget !== replacement.currentTarget ||
      current.target !== replacement.target ||
      current.identity !== replacement.identity
    ) {
      throw new Error(
        `Link ${replacement.linkPath} changed since preview or is no longer eligible. Apply selected groups again to review current conflicts.`,
      );
    }
    confirmed.add(replacement.linkPath);
    additions.push({
      skill: conflict.skill,
      linkPath: current.linkPath,
      target: current.target,
      replace: true,
      previousTarget: current.currentTarget,
      previousIdentity: current.identity,
    });
  }
  const confirmedPlan = {
    ...plan,
    additions,
    removals: replacements.length > 0 ? [] : plan.removals,
    conflicts: plan.conflicts.filter((entry) => !confirmed.has(entry.linkPath)),
  };
  const result = await applyPlan(confirmedPlan, { windows });
  const failed = [...result.failed];
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
  const output = toApplyResult({ explicitGroups, plan: confirmedPlan, result, failed });
  // Save ownership before reporting failures so retry can recover.
  try {
    await saveState(stateDir, { folder: catalogDir, groups: explicitGroups, links });
  } catch (error) {
    const rollback = await rollbackApply(result, windows);
    const recovered = toApplyResult({
      explicitGroups,
      plan: confirmedPlan,
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

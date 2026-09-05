// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - this synchronous Git audit is a standalone Node CLI that emits machine-readable JSON.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

import reviewed from "../../apps/server/src/j5/persistence/legacy-upstream-migrations.v1.json" with { type: "json" };

export interface MigrationRecord {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
}

export interface MigrationChange {
  readonly kind:
    | "invalid_manifest"
    | "removed"
    | "renumbered"
    | "implementation_changed"
    | "inserted_below_high_water";
  readonly name: string;
  readonly oldId?: number;
  readonly newId?: number;
}

/** Compares persisted migration identities and implementations, independently of filenames. */
export function inspectMigrationChanges(
  before: ReadonlyArray<MigrationRecord>,
  after: ReadonlyArray<MigrationRecord>,
): ReadonlyArray<MigrationChange> {
  const changes: Array<MigrationChange> = [];
  for (const records of [before, after]) {
    const ids = new Set<number>();
    const names = new Set<string>();
    for (const row of records) {
      if (!Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id) || names.has(row.name)) {
        changes.push({ kind: "invalid_manifest", name: row.name });
      }
      ids.add(row.id);
      names.add(row.name);
    }
  }
  const oldNames = new Set(before.map(({ name }) => name));
  const newNames = new Map(after.map((row) => [row.name, row]));
  const highWater = Math.max(0, ...before.map(({ id }) => id));
  for (const row of before) {
    const next = newNames.get(row.name);
    if (!next) {
      changes.push({ kind: "removed", name: row.name, oldId: row.id });
      continue;
    }
    if (row.id !== next.id) {
      changes.push({ kind: "renumbered", name: row.name, oldId: row.id, newId: next.id });
    }
    if (row.sha256 !== next.sha256) {
      changes.push({
        kind: "implementation_changed",
        name: row.name,
        oldId: row.id,
        newId: next.id,
      });
    }
  }
  for (const row of after) {
    if (!oldNames.has(row.name) && row.id <= highWater) {
      changes.push({ kind: "inserted_below_high_water", name: row.name, newId: row.id });
    }
  }
  return changes;
}

/** Allows only the recorded old manifest and exact reviewed upstream target. */
export function matchesReviewedBridge(
  before: ReadonlyArray<MigrationRecord>,
  after: ReadonlyArray<MigrationRecord>,
  targetSha: string,
): boolean {
  if (
    targetSha !== reviewed.targetRef ||
    before.length !== reviewed.migrations.length ||
    after.length !== 59
  ) {
    return false;
  }
  if (
    inspectMigrationChanges(before, after).some(
      ({ kind }) =>
        kind === "invalid_manifest" || kind === "removed" || kind === "implementation_changed",
    )
  ) {
    return false;
  }
  const originalNames = new Set(reviewed.migrations.map(({ name }) => name));
  const additions = after
    .filter(({ name }) => !originalNames.has(name))
    .map(({ id }) => id)
    .sort((a, b) => a - b);
  if (additions.join(",") !== "41,42,43,44,45,46,47,57,58,59") return false;
  return reviewed.migrations.every((expected) => {
    const old = before.find(({ id }) => id === expected.id);
    const next = after.find(({ name }) => name === expected.name);
    return (
      old?.name === expected.name &&
      old.sha256 === expected.sha256 &&
      next?.id === (expected.id >= 41 ? expected.id + 7 : expected.id) &&
      next.sha256 === expected.sha256
    );
  });
}

const gitText = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

/** Reads the repository's static manifest; unfamiliar syntax fails instead of producing an empty audit. */
export function readMigrationManifest(cwd: string, sha: string): ReadonlyArray<MigrationRecord> {
  const source = gitText(cwd, "show", `${sha}:apps/server/src/persistence/Migrations.ts`);
  const imports = new Map(
    [...source.matchAll(/import (Migration\d+) from "\.\/(Migrations\/[^"\n]+)";/g)].map(
      (match) => [match[1]!, match[2]!] as const,
    ),
  );
  const entries = [...source.matchAll(/\[(\d+), "([^"]+)", (Migration\d+)\]/g)];
  if (entries.length === 0 || entries.length !== imports.size) {
    throw new Error(
      "Unrecognized migration manifest syntax; update the audit before advancing the pin.",
    );
  }
  return entries.map((match) => {
    const relativePath = imports.get(match[3]!);
    if (!relativePath) throw new Error("Migration entry has no static implementation import.");
    const path = `apps/server/src/persistence/${relativePath}`;
    const implementation = gitText(cwd, "show", `${sha}:${path}`);
    return {
      id: Number(match[1]),
      name: match[2]!,
      path,
      sha256: NodeCrypto.createHash("sha256").update(implementation).digest("hex"),
    };
  });
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      base: { type: "string" },
      candidate: { type: "string" },
      "allow-reviewed-bridge": { type: "boolean", default: false },
    },
  });
  if (!values.base || !values.candidate) {
    throw new Error(
      "Usage: node scripts/j5/check-upstream-migrations.ts --base <ref> --candidate <ref> [--allow-reviewed-bridge]",
    );
  }
  const cwd = process.cwd();
  const base = gitText(
    cwd,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values.base}^{commit}`,
  ).trim();
  const candidate = gitText(
    cwd,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values.candidate}^{commit}`,
  ).trim();
  const before = readMigrationManifest(cwd, base);
  const after = readMigrationManifest(cwd, candidate);
  const changes = inspectMigrationChanges(before, after);
  const bridge = values["allow-reviewed-bridge"] && matchesReviewedBridge(before, after, candidate);
  const status =
    changes.length === 0 ? "append_only" : bridge ? "reviewed_bridge_required" : "blocked";
  console.log(
    JSON.stringify(
      { base, candidate, status, changes, databaseUpgradeProofRequired: changes.length !== 0 },
      null,
      2,
    ),
  );
  process.exitCode = status === "blocked" ? 1 : 0;
}

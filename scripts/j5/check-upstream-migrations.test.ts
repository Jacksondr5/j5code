// @effect-diagnostics nodeBuiltinImport:off - synchronous Git CLI fixtures use an isolated temporary repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import collapse from "../../apps/server/src/j5/persistence/reviewed-v2-collapse.v1.json" with { type: "json" };
import reviewed from "../../apps/server/src/j5/persistence/legacy-upstream-migrations.v1.json" with { type: "json" };
import {
  inspectMigrationChanges,
  readMigrationDependencies,
  matchesReviewedBridge,
  type MigrationRecord,
} from "./check-upstream-migrations.ts";

const record = (id: number, name: string, sha256 = "same"): MigrationRecord => ({
  id,
  name,
  sha256,
  path: `${id}_${name}.ts`,
});

describe("upstream migration compatibility audit", () => {
  it("accepts append-only additions and implementation-preserving path moves", () => {
    const before = [record(1, "First"), record(2, "Second")];
    expect(
      inspectMigrationChanges(before, [
        { ...record(1, "First"), path: "moved/First.ts" },
        record(2, "Second"),
        record(3, "Third"),
      ]),
    ).toEqual([]);
  });

  it("detects renumbering and an inserted migration that the high-water runner would skip", () => {
    expect(
      inspectMigrationChanges(
        [record(1, "First"), record(2, "Second")],
        [record(1, "First"), record(2, "Inserted"), record(3, "Second")],
      ),
    ).toEqual([
      { kind: "renumbered", name: "Second", oldId: 2, newId: 3 },
      { kind: "inserted_below_high_water", name: "Inserted", newId: 2 },
    ]);
  });

  it("detects renamed, removed, and edited historical migrations", () => {
    expect(
      inspectMigrationChanges(
        [record(1, "First"), record(2, "Second"), record(3, "Third")],
        [record(1, "Renamed"), record(3, "Third", "changed")],
      ),
    ).toEqual([
      { kind: "removed", name: "First", oldId: 1 },
      { kind: "removed", name: "Second", oldId: 2 },
      { kind: "implementation_changed", name: "Third", oldId: 3, newId: 3 },
      { kind: "inserted_below_high_water", name: "Renamed", newId: 1 },
    ]);
  });

  it("rejects duplicate IDs and identities", () => {
    expect(inspectMigrationChanges([], [record(1, "One"), record(1, "Two")])).toContainEqual({
      kind: "invalid_manifest",
      name: "Two",
    });
    expect(inspectMigrationChanges([], [record(1, "One"), record(2, "One")])).toContainEqual({
      kind: "invalid_manifest",
      name: "One",
    });
  });

  it("bounds the bridge exception to its reviewed source manifest, mapping, and target", () => {
    const before = reviewed.migrations;
    const after = [
      ...before.map((row) => ({ ...row, id: row.id >= 41 ? row.id + 7 : row.id })),
      ...[41, 42, 43, 44, 45, 46, 47, 57, 58, 59].map((id) => record(id, `Inserted${id}`)),
    ];
    expect(matchesReviewedBridge(before, after, reviewed.targetRef)).toBe(true);
    expect(matchesReviewedBridge(before, after, "unreviewed-target")).toBe(false);
    expect(
      matchesReviewedBridge(
        before,
        after.map((row) => (row.id === 50 ? { ...row, sha256: "changed" } : row)),
        reviewed.targetRef,
      ),
    ).toBe(false);
    expect(matchesReviewedBridge(before.slice(1), after, reviewed.targetRef)).toBe(false);
    expect(
      matchesReviewedBridge(
        before,
        after.map((row) => (row.id === 50 ? { ...row, id: 60 } : row)),
        reviewed.targetRef,
      ),
    ).toBe(false);
  });
});

describe("reviewed V2 composition", () => {
  it("accepts only the recorded August/September sources and exact composed target", () => {
    for (const source of [reviewed.migrations, collapse.sourceMigrations]) {
      expect(matchesReviewedBridge(source, collapse.targetMigrations, collapse.targetRef)).toBe(
        true,
      );
      expect(
        matchesReviewedBridge(source.slice(0, -1), collapse.targetMigrations, collapse.targetRef),
      ).toBe(false);
      expect(matchesReviewedBridge(source, collapse.targetMigrations, "different-target")).toBe(
        false,
      );
    }
  });
  it("detects a helper change even when the top-level migration did not change", () => {
    for (const id of [50, 51]) {
      const changed = collapse.targetMigrations.map((row) =>
        row.id === id
          ? {
              ...row,
              dependencies: (row.dependencies ?? []).map((dep, index) =>
                index === 0 ? { ...dep, sha256: "edited" } : dep,
              ),
            }
          : row,
      );
      expect(matchesReviewedBridge(collapse.sourceMigrations, changed, collapse.targetRef)).toBe(
        false,
      );
      expect(inspectMigrationChanges(collapse.targetMigrations, changed)).toContainEqual({
        kind: "implementation_changed",
        name: collapse.targetMigrations[id - 1]!.name,
        oldId: id,
        newId: id,
      });
    }
  });
  it("refuses unfamiliar static or dynamic migration composition", () => {
    const path = "apps/server/src/persistence/Migrations/051_OrchestrationV2.ts";
    expect(() =>
      readMigrationDependencies("unused", "unused", path, 'import NewStep from "./new.ts";'),
    ).toThrow(/Unreviewed migration composition/);
    expect(() =>
      readMigrationDependencies("unused", "unused", path, 'await import("./new.ts")'),
    ).toThrow(/dynamic migration dependency/);
  });
});

it("reads helper and backfill dependency changes from Git even with unchanged entry points", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-migration-audit-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    for (const migration of collapse.targetMigrations.filter(({ id }) => id === 50 || id === 51)) {
      const dependencies = migration.dependencies ?? [];
      for (const dependency of dependencies) {
        const file = NodePath.join(directory, dependency.path);
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(file, "original");
      }
      git("add", ".");
      const before = git("write-tree");
      const implementation =
        migration.id === 51
          ? dependencies
              .map(
                ({ path }, index) =>
                  `import Step${index} from "./OrchestrationV2/${NodePath.basename(path)}";`,
              )
              .join("\n")
          : 'import { legacyThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";';
      const original = readMigrationDependencies(directory, before, migration.path, implementation);
      for (const dependency of dependencies) {
        NodeFS.writeFileSync(
          NodePath.join(directory, dependency.path),
          "changed SQL or backfill behavior",
        );
        git("add", ".");
        const after = readMigrationDependencies(
          directory,
          git("write-tree"),
          migration.path,
          implementation,
        );
        expect(after.find(({ path }) => path === dependency.path)?.sha256).not.toBe(
          original.find(({ path }) => path === dependency.path)?.sha256,
        );
        expect(
          inspectMigrationChanges(
            [{ ...migration, dependencies: original }],
            [{ ...migration, dependencies: after }],
          ),
        ).toContainEqual({
          kind: "implementation_changed",
          name: migration.name,
          oldId: migration.id,
          newId: migration.id,
        });
        NodeFS.writeFileSync(NodePath.join(directory, dependency.path), "original");
      }
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

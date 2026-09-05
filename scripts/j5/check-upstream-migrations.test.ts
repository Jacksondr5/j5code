import { describe, expect, it } from "vite-plus/test";

import reviewed from "../../apps/server/src/j5/persistence/legacy-upstream-migrations.v1.json" with { type: "json" };
import {
  inspectMigrationChanges,
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

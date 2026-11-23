// @effect-diagnostics nodeBuiltinImport:off - read synchronously by the service preflight subprocess and at startup.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import type { J5DatabaseMigrations } from "@t3tools/shared/j5/databaseMigrations";

import { J5_A2A_MIGRATIONS_TABLE, migrationEntries } from "../a2a/Migrations.ts";
import {
  RUN_OBSERVABILITY_MIGRATIONS_TABLE,
  runObservabilityMigrationIds,
} from "../run-observability/Migrations.ts";

/** The newest migration this build knows in each J5 ledger. */
export const J5_BUILD_MIGRATION_HEADS: J5DatabaseMigrations = {
  [J5_A2A_MIGRATIONS_TABLE]: Math.max(...migrationEntries.map(([id]) => id)),
  [RUN_OBSERVABILITY_MIGRATIONS_TABLE]: Math.max(...runObservabilityMigrationIds),
};

interface RecordedMigration {
  readonly table: string;
  readonly id: number;
  readonly name: string;
}

/** Every J5 ledger's recorded migrations, read-only. A missing database or ledger records none; a
 * database that exists but cannot be read is null. Mirrors upstream's `recordedMigrations`. */
function recordedJ5Migrations(databasePath: string): ReadonlyArray<RecordedMigration> | null {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return NodeFS.existsSync(databasePath) ? null : [];
  }
  try {
    return Object.keys(J5_BUILD_MIGRATION_HEADS).flatMap((table) => {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (exists === undefined) return [];
      return db
        .prepare(`SELECT migration_id, name FROM "${table}" ORDER BY migration_id`)
        .all()
        .map((row) => ({ table, id: Number(row.migration_id), name: String(row.name) }));
    });
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // A read-only handle has nothing to flush; the result above already stands.
    }
  }
}

/** Adds J5's ledgers to upstream's preflight answer: null when either history is unknown. */
export function withNewerJ5Migrations(
  databasePath: string,
  upstream: ReadonlyArray<string> | null,
): ReadonlyArray<string> | null {
  if (upstream === null) return null;
  const recorded = recordedJ5Migrations(databasePath);
  if (recorded === null) return null;
  return [
    ...upstream,
    ...recorded
      .filter(({ table, id }) => id > J5_BUILD_MIGRATION_HEADS[table]!)
      .map(({ table, id, name }) => `${table} ${id}_${name}`),
  ];
}

/** Each J5 ledger's newest migration once this build's startup migrations have run; a newer build
 * may have recorded more. Undefined when the database cannot be read. */
export function j5DatabaseMigrationHeads(databasePath: string): J5DatabaseMigrations | undefined {
  const recorded = recordedJ5Migrations(databasePath);
  if (recorded === null) return undefined;
  return Object.fromEntries(
    Object.entries(J5_BUILD_MIGRATION_HEADS).map(([table, head]) => [
      table,
      Math.max(head, ...recorded.filter((row) => row.table === table).map(({ id }) => id)),
    ]),
  );
}

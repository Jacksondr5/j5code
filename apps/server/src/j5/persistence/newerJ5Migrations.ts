// @effect-diagnostics nodeBuiltinImport:off - read synchronously by the service preflight subprocess.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { J5_A2A_MIGRATIONS_TABLE, migrationEntries } from "../a2a/Migrations.ts";
import {
  RUN_OBSERVABILITY_MIGRATIONS_TABLE,
  runObservabilityMigrationIds,
} from "../run-observability/Migrations.ts";

const j5Ledgers = [
  { table: J5_A2A_MIGRATIONS_TABLE, head: Math.max(...migrationEntries.map(([id]) => id)) },
  { table: RUN_OBSERVABILITY_MIGRATIONS_TABLE, head: Math.max(...runObservabilityMigrationIds) },
];

/** Migrations a newer build recorded in J5's ledgers, read-only, or null when the database exists
 * but cannot be read. Mirrors upstream's `recordedMigrations`. */
function newerJ5RecordedMigrations(databasePath: string): ReadonlyArray<string> | null {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return NodeFS.existsSync(databasePath) ? null : [];
  }
  try {
    return j5Ledgers.flatMap(({ table, head }) => {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (exists === undefined) return [];
      return db
        .prepare(
          `SELECT migration_id, name FROM "${table}" WHERE migration_id > ? ORDER BY migration_id`,
        )
        .all(head)
        .map((row) => `${table} ${Number(row.migration_id)}_${String(row.name)}`);
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
  const j5 = newerJ5RecordedMigrations(databasePath);
  return j5 === null ? null : [...upstream, ...j5];
}

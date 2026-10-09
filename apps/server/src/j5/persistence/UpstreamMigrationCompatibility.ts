import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import { publishDatabaseSnapshot } from "./LedgerMigrationSnapshot.ts";

interface HistoryRow {
  readonly migration_id: number;
  readonly name: string;
}

const v2Name = "OrchestrationV2";

/**
 * The history J5 0.0.48 leaves behind (upstream pin `67a2be0fdb`): upstream's 1–53, then V2 at 54
 * and the index cleanup at 55. Upstream's `reconcileV2PreviewMigration` moves those two up by one
 * and records the new 054.
 */
export const pinMigrationHistory: ReadonlyArray<readonly [number, string]> = [
  ...migrationManifest.filter(([id]) => id <= 53),
  [54, v2Name],
  [55, "RemoveRedundantProjectionIndexes"],
];

const isPinHistory = (history: ReadonlyArray<HistoryRow>) =>
  history.length === pinMigrationHistory.length &&
  history.every(
    (row, index) =>
      row.migration_id === pinMigrationHistory[index]?.[0] &&
      row.name === pinMigrationHistory[index]?.[1],
  );

/** Where V2 was recorded by the histories that only J5 0.0.48 and earlier could upgrade. */
const retiredV2Ids: ReadonlySet<number> = new Set([41, 48, 51]);

const describeCause = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class UpstreamRenumberSnapshotError extends Schema.TaggedError<UpstreamRenumberSnapshotError>()(
  "UpstreamRenumberSnapshotError",
  {
    databasePath: Schema.String,
    snapshotPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not snapshot ${this.databasePath} to ${this.snapshotPath} before upstream's migrations are renumbered: ${describeCause(this.cause)}. Nothing has been migrated.`;
  }
}

/** `statev2.sqlite` → `statev2.pre-upstream-renumber.sqlite`, beside the database. */
export const upstreamRenumberSnapshotPath = (path: Path.Path, dbPath: string) =>
  path.join(
    path.dirname(dbPath),
    `${path.basename(dbPath, ".sqlite")}.pre-upstream-renumber.sqlite`,
  );

const hasPinHistory = (filename: string) => {
  const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    const table = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get();
    if (table === undefined) return false;
    const rows = database
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    return isPinHistory(
      rows.map((row) => ({ migration_id: Number(row.migration_id), name: String(row.name) })),
    );
  } finally {
    database.close();
  }
};

/**
 * Call before anything opens the database read-write. A database still on the previous pin's
 * history is about to have its migration rows renumbered by upstream, so it is first copied to
 * `statev2.pre-upstream-renumber.sqlite`; a failed copy fails here and nothing migrates. Nothing
 * deletes the snapshot; a person does.
 */
export const snapshotBeforeUpstreamRenumber = Effect.fn("snapshotBeforeUpstreamRenumber")(
  function* (dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const snapshotPath = upstreamRenumberSnapshotPath(path, dbPath);
    const fail = (cause: unknown) =>
      new UpstreamRenumberSnapshotError({ databasePath: dbPath, snapshotPath, cause });
    if (!(yield* fs.exists(dbPath).pipe(Effect.mapError(fail)))) return;
    if (!(yield* Effect.try({ try: () => hasPinHistory(dbPath), catch: fail }))) return;
    yield* publishDatabaseSnapshot({
      dbPath,
      snapshotPath,
      reason: "upstream's migration renumbering",
      stillPending: hasPinHistory,
      fail,
    });
  },
);

/**
 * Runs upstream's migrations. A prefix of upstream's manifest goes to the ordinary migrator, and
 * the previous pin's history is renumbered by upstream's own `reconcileV2PreviewMigration` inside
 * `runMigrations` (`snapshotBeforeUpstreamRenumber` has copied the database first). The only
 * histories J5 refuses are the three older ones whose upgrade arms ended with J5 0.0.48.
 */
export const runJ5CompatibleUpstreamMigrations = Effect.fn("J5.runCompatibleUpstreamMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    const history =
      tables.length === 0
        ? []
        : yield* sql<HistoryRow>`SELECT migration_id, name FROM effect_sql_migrations`;
    const retired = history.find(
      (row) => row.name === v2Name && retiredV2Ids.has(row.migration_id),
    );
    if (retired !== undefined) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `This database was last migrated by a J5 Code release this version can no longer upgrade (its history records ${retired.migration_id} = ${v2Name}). Run \`j5 update 0.0.48\` first, then update again.`,
      });
    }
    return yield* runMigrations();
  },
);

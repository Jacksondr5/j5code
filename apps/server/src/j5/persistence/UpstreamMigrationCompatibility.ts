import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";

interface HistoryRow {
  readonly migration_id: number;
  readonly name: string;
}

const v2Name = "OrchestrationV2";

/** Where V2 was recorded by the histories that only J5 0.0.48 and earlier could upgrade. */
const retiredV2Ids: ReadonlySet<number> = new Set([41, 48, 51]);

/**
 * Runs upstream's migrations. A prefix of upstream's manifest goes to the ordinary migrator, and
 * the previous pin's history is renumbered by upstream's own `reconcileV2PreviewMigration` inside
 * `runMigrations` (`snapshotBeforeMigrations` has copied the database first). The only
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

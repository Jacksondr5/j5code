import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

export const RUN_OBSERVABILITY_MIGRATIONS_TABLE = "j5_run_observability_migrations";

const migrations = {
  "1_QueuedRunWatchdogLookup": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE INDEX j5_run_observability_status_requested_run_idx
      ON orchestration_v2_projection_runs(status, requested_at, run_id)`;
  }),
};

export const runObservabilityMigrationIds = Object.keys(migrations).map((key) =>
  Number.parseInt(key, 10),
);

/** Whether this lane has a migration to run: the migrator runs every id above the newest recorded. */
export const hasPendingRunObservabilityMigrations = Effect.fn(
  "hasPendingRunObservabilityMigrations",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${RUN_OBSERVABILITY_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return true;
  const rows = yield* sql<{ readonly latestId: number | null }>`
    SELECT MAX(migration_id) AS latestId FROM ${sql(RUN_OBSERVABILITY_MIGRATIONS_TABLE)}
  `;
  return (rows[0]?.latestId ?? 0) < Math.max(...runObservabilityMigrationIds);
});

// This lane runs after upstream persistence is ready and never consumes an upstream migration id.
const run = Migrator.make({});
export const runMigrations = Effect.fn("j5.runObservabilityMigrations")(function* () {
  return yield* run({
    table: RUN_OBSERVABILITY_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(migrations),
  });
});

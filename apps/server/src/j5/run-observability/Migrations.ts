import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// This lane runs after upstream persistence is ready and never consumes an upstream migration id.
const run = Migrator.make({});
export const runMigrations = Effect.fn("j5.runObservabilityMigrations")(function* () {
  return yield* run({
    table: "j5_run_observability_migrations",
    loader: Migrator.fromRecord({
      "1_QueuedRunWatchdogLookup": Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE INDEX j5_run_observability_status_requested_run_idx
          ON orchestration_v2_projection_runs(status, requested_at, run_id)`;
      }),
    }),
  });
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Supports fair, bounded watchdog scans of stale starting runs. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_status_requested_run_idx
    ON orchestration_v2_projection_runs(status, requested_at, run_id)
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN latest_revision_json TEXT`;
  yield* sql`CREATE TABLE j5_playbook_revision (
    run_id TEXT NOT NULL REFERENCES j5_playbook_run(run_id),
    request_id TEXT NOT NULL,
    basis TEXT NOT NULL CHECK (basis IN ('asked', 'approved')),
    revised_at TEXT NOT NULL,
    owner_thread_id TEXT NOT NULL,
    from_step_id TEXT NOT NULL,
    to_step_id TEXT NOT NULL,
    steps_digest TEXT NOT NULL,
    PRIMARY KEY (run_id, request_id)
  )`;
});

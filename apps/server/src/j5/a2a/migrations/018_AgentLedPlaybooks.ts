import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE j5_playbook_run (
    run_id TEXT PRIMARY KEY,
    owner_thread_id TEXT NOT NULL,
    definition_path TEXT NOT NULL,
    current_step_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX j5_playbook_active_owner
    ON j5_playbook_run(owner_thread_id) WHERE status = 'active'`;
  yield* sql`CREATE INDEX j5_playbook_owner ON j5_playbook_run(owner_thread_id, created_at)`;
  // A request remains consumed even after back navigation returns to its expected step.
  yield* sql`CREATE TABLE j5_playbook_request (
    owner_thread_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES j5_playbook_run(run_id),
    PRIMARY KEY (owner_thread_id, request_id)
  )`;
});

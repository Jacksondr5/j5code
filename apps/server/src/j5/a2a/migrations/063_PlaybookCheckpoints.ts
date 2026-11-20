import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN checkpoint_request_id TEXT`;
  yield* sql`CREATE TABLE j5_playbook_checkpoint (
    request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, owner_thread_id TEXT NOT NULL,
    step_id TEXT NOT NULL, step_title TEXT NOT NULL, summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','declined','closed')),
    created_at TEXT NOT NULL, answered_at TEXT, reason TEXT, notified_at TEXT
  )`;
  yield* sql`CREATE INDEX j5_playbook_run_checkpoint ON j5_playbook_run(checkpoint_request_id) WHERE checkpoint_request_id IS NOT NULL`;
  yield* sql`CREATE INDEX j5_playbook_checkpoint_pending ON j5_playbook_checkpoint(status, created_at)`;
});

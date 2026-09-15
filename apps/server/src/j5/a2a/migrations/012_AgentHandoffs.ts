import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** One row per saved-agent task with a declared output artifact; status follows the run-end check. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_agent_handoffs (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      artifact TEXT NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      checked_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX j5_agent_handoffs_project_idx ON j5_agent_handoffs(project_id, checked_at)`;
});

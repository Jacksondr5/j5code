import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE j5_playbook_staffing_launch (
    run_id TEXT NOT NULL REFERENCES j5_playbook_run(run_id), step_id TEXT NOT NULL, persona_id TEXT NOT NULL,
    PRIMARY KEY (run_id, step_id, persona_id))`;
  // Earlier approvals recorded just a definition digest and cannot authorize scoped launches.
  yield* sql`UPDATE j5_playbook_checkpoint SET status = 'closed' WHERE persona_picks_json IS NOT NULL`;
  yield* sql`DROP INDEX j5_playbook_persona_approval`;
  yield* sql`CREATE UNIQUE INDEX j5_playbook_persona_approval ON j5_playbook_checkpoint(run_id)
    WHERE persona_picks_json IS NOT NULL AND status <> 'closed'`;
});

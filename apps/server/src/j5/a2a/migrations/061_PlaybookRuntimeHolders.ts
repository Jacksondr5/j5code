import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN holder_participant_id TEXT`;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN holder_thread_id TEXT`;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN assigned_by_participant_id TEXT`;
  yield* sql`ALTER TABLE j5_playbook_step_delivery ADD COLUMN target_participant_id TEXT`;
  yield* sql`ALTER TABLE j5_playbook_step_delivery ADD COLUMN assigned_by_participant_id TEXT`;
});

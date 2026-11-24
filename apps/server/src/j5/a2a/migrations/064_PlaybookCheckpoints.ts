import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN checkpoint_request_id TEXT`;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN checkpoint_summary TEXT`;
});

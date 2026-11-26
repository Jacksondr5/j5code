import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN definition_json TEXT`;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN cancel_reason TEXT`;
  yield* sql`UPDATE j5_playbook_run SET status = 'cancelled',
    cancel_reason = 'started before runs kept their own copy; start it again.'
    WHERE status = 'active'`;
});

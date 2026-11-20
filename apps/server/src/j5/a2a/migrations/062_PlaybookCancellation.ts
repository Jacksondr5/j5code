import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN holder_stop_json TEXT`;
  // A historical cancellation must never stop the former holder's newer work on retry.
  yield* sql`UPDATE j5_playbook_run SET holder_stop_json =
    '{"status":"failed","reason":"Cancelled before holder Stop outcomes were recorded; no Stop will be issued."}'
    WHERE status = 'cancelled'`;
});

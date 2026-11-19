import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_playbook_step_delivery ADD COLUMN playbook_origin_json TEXT`;
  yield* sql`ALTER TABLE j5_playbook_checkpoint ADD COLUMN playbook_origin_json TEXT`;
});

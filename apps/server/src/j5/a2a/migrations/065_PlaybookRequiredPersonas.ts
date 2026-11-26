import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN required_personas_json TEXT`;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN persona_block_reason TEXT`;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN persona_request_id TEXT`;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN persona_picks_json TEXT`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX j5_playbook_checkpoint_unnotified ON j5_playbook_checkpoint(status, run_id)
    WHERE notified_at IS NULL AND status IN ('approved', 'declined')`;
});

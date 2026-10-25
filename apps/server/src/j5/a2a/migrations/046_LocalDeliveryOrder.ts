import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Messages reach an agent on this server in the order they were accepted, from whichever project:
// a delivery waits behind an earlier one to the same agent, and a wake hands an agent's waiting
// deliveries over together. Both seek its waiting rows by acceptance order. A recheck while held
// is not a transport failure, so it is counted apart from the attempts that lead to an alarm.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN held_attempts INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE INDEX j5_a2a_delivery_local_waiting_idx
    ON j5_a2a_delivery (receiver_id, created_at, sent_seq, project_id, message_id)
    WHERE receiver_environment_id IS NULL AND status IN ('pending', 'retry_scheduled')
  `;
});

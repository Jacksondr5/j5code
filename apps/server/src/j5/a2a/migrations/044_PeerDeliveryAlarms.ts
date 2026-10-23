import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE j5_a2a_peer_delivery_alarm (
    project_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    reported_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (project_id, message_id),
    FOREIGN KEY (project_id, message_id)
      REFERENCES j5_a2a_delivery(project_id, message_id) ON DELETE CASCADE
  )`;
});

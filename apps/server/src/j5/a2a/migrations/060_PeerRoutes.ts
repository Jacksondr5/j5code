import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A spawn across servers records where the other side's agent lives before either has sent a
// message, so a send to it is routed before any delivery or received row exists.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_peer_route (
      participant_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
});

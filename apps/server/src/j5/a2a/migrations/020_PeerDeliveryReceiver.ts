import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// A delivery whose receiver is homed on a peer server names that server here.
// NULL means the receiver is on this server, which is every row written before
// peering existed. The worker hands such a row to the peer transport and lets
// the peer write its own received row.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN receiver_environment_id TEXT`;
});

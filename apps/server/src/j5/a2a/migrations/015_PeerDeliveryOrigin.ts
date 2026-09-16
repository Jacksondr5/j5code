import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// A delivery row that came in from a peer server is owned by the receiver's
// Squadron ledger, so `squadron_id` can no longer double as the origin. These
// two columns name the real origin; NULL means the origin is `squadron_id`
// on this server, which is every row written before peering existed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN origin_squadron_id TEXT`;
  yield* sql`ALTER TABLE j5_a2a_delivery ADD COLUMN origin_environment_id TEXT`;
});

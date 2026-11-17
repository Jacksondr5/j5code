import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A peer that polls this server holds a line here, reached at a loopback address built from its
// slot. A slot is the peer's for as long as it stays recorded, so a link made at the address keeps
// working from one line to the next. Peers already polling get theirs now.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_peer_line (
      environment_id TEXT PRIMARY KEY,
      slot INTEGER NOT NULL UNIQUE
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_peer_line (environment_id, slot)
    SELECT environment_id, ROW_NUMBER() OVER (ORDER BY created_at, environment_id)
    FROM j5_a2a_peer
    WHERE link_mode = 'store'
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Upstream's session for a link names no environment. The server that holds the link says which
// one it is, so removing that server here can revoke the sessions its links hold.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_link_session (
      session_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX j5_link_session_environment ON j5_link_session (environment_id)`;
});

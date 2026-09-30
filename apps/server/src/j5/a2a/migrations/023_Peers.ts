import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// A peer is another server this one exchanges agent messages with. One row per
// peer environment: the origin this server reaches it at, the credential that
// server issued to us, and when that credential expires. The session we issued
// to the peer lives in the auth database like any other session; removing a
// peer revokes it there.
// TODO(#282): the credential is stored in clear text, like the session tokens
// beside it; moving it into ServerSecretStore is tracked separately.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_peer (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      origin TEXT NOT NULL,
      credential TEXT NOT NULL,
      credential_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});

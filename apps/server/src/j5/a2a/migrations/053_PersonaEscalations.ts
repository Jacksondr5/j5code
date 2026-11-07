import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A refused persona launch, one row each. An ask to the person links its exchange; the Owner's
 * "Allow this once" grants it, and the one retry it allows uses it. `waivable` is the single limit
 * a grant lifts, null when none would let the persona run; `scope_json` is what the grant covers.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_persona_escalation (
      id TEXT PRIMARY KEY,
      caller_participant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      code TEXT NOT NULL,
      summary TEXT NOT NULL,
      waivable TEXT,
      scope_json TEXT,
      exchange_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('open', 'granted', 'used')),
      created_at TEXT NOT NULL,
      granted_by TEXT,
      granted_at TEXT,
      used_at TEXT
    )
  `;
});

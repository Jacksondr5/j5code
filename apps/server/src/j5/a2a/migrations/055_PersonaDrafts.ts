import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A persona create or edit an agent drafted, one row each. An ask to the person links its exchange;
 * the Owner's "Save persona" writes it to the library once. `target_kind` is where an edit landed
 * when drafted (`imported` or `folder`), so a save refuses a target that has since moved.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_persona_draft (
      id TEXT PRIMARY KEY,
      proposer_participant_id TEXT NOT NULL,
      proposer_thread_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('create', 'edit')),
      persona_id TEXT NOT NULL,
      target_kind TEXT CHECK (target_kind IN ('imported', 'folder')),
      base_digest TEXT,
      fields_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      exchange_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('open', 'saved')),
      created_at TEXT NOT NULL,
      saved_by TEXT,
      saved_at TEXT
    )
  `;
});

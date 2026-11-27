import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The J5 Connect a server trusts (its client secret is in the secret store), its accounts, and
// sign-ins on their way back. An account binds to at most one person and a person to one account.
// Sessions and waiting credentials from sign-in name their account, so a lapse ends exactly those;
// pairing and renewal refuse an account not bound or whose sign-in ended (`sign_in_ended_at`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_identity_connect (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      issuer TEXT NOT NULL,
      client_id TEXT NOT NULL,
      return_urls_json TEXT NOT NULL,
      joined_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE j5_identity_account (
      account_id TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      email TEXT,
      name TEXT,
      person_id TEXT UNIQUE,
      bound_at TEXT,
      refresh_token TEXT,
      last_confirmed_at TEXT,
      requested_at TEXT,
      declined_at TEXT,
      sign_in_ended_at TEXT,
      UNIQUE (issuer, subject),
      FOREIGN KEY (person_id) REFERENCES j5_a2a_human_person(person_id),
      CHECK ((person_id IS NULL) = (bound_at IS NULL))
    )
  `;

  yield* sql`
    CREATE TABLE j5_identity_sign_in (
      state TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      return_url TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;

  yield* sql`ALTER TABLE j5_a2a_person_session ADD COLUMN sign_in_account_id TEXT`;
  yield* sql`
    CREATE INDEX j5_a2a_person_session_sign_in_idx
    ON j5_a2a_person_session(sign_in_account_id) WHERE sign_in_account_id IS NOT NULL
  `;
  yield* sql`ALTER TABLE j5_a2a_pairing_intent ADD COLUMN sign_in_account_id TEXT`;
});

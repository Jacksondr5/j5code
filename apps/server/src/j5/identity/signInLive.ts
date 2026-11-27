import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Whether a J5 Connect account still vouches for its person: bound to them, and its sign-in not
 * ended by a lapse. Read inside the write transaction that pairs or renews a session from it, so
 * an unbind, lapse or leave that commits first refuses the session, and one that commits after
 * finds the session to end.
 */
export const signInLive = Effect.fn("j5.identity.signInLive")(function* (
  sql: SqlClient.SqlClient,
  accountId: string,
  personId: string,
) {
  const rows = yield* sql`
    SELECT 1 AS live FROM j5_identity_account
    WHERE account_id = ${accountId} AND person_id = ${personId} AND sign_in_ended_at IS NULL
  `;
  return rows.length > 0;
});

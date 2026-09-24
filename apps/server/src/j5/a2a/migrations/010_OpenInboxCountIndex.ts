import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Poll-friendly B1 count lookup; SQLite still scans matching open rows for the resolved person. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX j5_a2a_human_inbox_open_person_idx
    ON j5_a2a_human_inbox(person_id)
    WHERE status = 'open'
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A Crew follows its Captain, so a Crew that retired because its Captain was archived comes back
 * when the Captain is unarchived, and one retired on its own does not. The flag records which.
 * Crews retired before this migration read as retired on their own.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE j5_agent_crew_instance
    ADD COLUMN retired_with_captain INTEGER NOT NULL DEFAULT 0
  `;
});

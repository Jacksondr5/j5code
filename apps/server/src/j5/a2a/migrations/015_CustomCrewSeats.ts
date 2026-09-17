import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// A seat may run without a saved agent (Jackson's review, 2026-09-17): the person names and briefs
// it on the card, or the Captain proposes it with no agent id, and it runs on the Captain's own
// provider, model, and runtime mode. The member row's agent_id becomes nullable. SQLite cannot
// relax a NOT NULL in place, so the table is rebuilt with the same columns and its rows carried.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_agent_crew_member_next (
      crew_instance_id TEXT NOT NULL,
      seat_name TEXT NOT NULL,
      agent_id TEXT,
      participant_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      added_version INTEGER NOT NULL CHECK (added_version >= 1),
      reason TEXT,
      PRIMARY KEY (crew_instance_id, seat_name),
      FOREIGN KEY (crew_instance_id) REFERENCES j5_agent_crew_instance(id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    INSERT INTO j5_agent_crew_member_next
      (crew_instance_id, seat_name, agent_id, participant_id, thread_id, ordinal, added_version, reason)
    SELECT crew_instance_id, seat_name, agent_id, participant_id, thread_id, ordinal, added_version, reason
    FROM j5_agent_crew_member
  `;
  yield* sql`DROP TABLE j5_agent_crew_member`;
  yield* sql`ALTER TABLE j5_agent_crew_member_next RENAME TO j5_agent_crew_member`;
});

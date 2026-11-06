import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A member a Captain replaced leaves the live roster for this table, keeping the steps it
 * finished and who took its place. Its seat name may be taken again by its replacement, so it
 * is keyed by participant rather than by seat.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_agent_crew_replaced_member (
      crew_instance_id TEXT NOT NULL,
      participant_id TEXT NOT NULL PRIMARY KEY,
      seat_name TEXT NOT NULL,
      agent_id TEXT,
      thread_id TEXT NOT NULL,
      added_version INTEGER NOT NULL,
      reason TEXT,
      playbook_step_ids TEXT,
      replaced_by_seat TEXT NOT NULL,
      replaced_by_participant_id TEXT NOT NULL,
      replaced_at TEXT NOT NULL,
      FOREIGN KEY (crew_instance_id) REFERENCES j5_agent_crew_instance(id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX j5_agent_crew_replaced_member_crew
    ON j5_agent_crew_replaced_member (crew_instance_id)
  `;
});

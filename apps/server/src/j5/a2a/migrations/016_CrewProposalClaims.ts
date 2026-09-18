import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// A resolution claims its proposal first (`approving`, `declining`), does its work, then writes
// the final status, so two devices resolving one reopened gate cannot undo each other; and the
// Captain is told how an approval launched by one report, recorded in `reported_at`, so a boot
// sweep can find a report the server never posted (Jackson's review and dogfood, 2026-09-17).
// SQLite cannot widen a CHECK in place, so the table is rebuilt with its rows carried. Proposals
// approved before this change were told under the old scheme, so they count as reported: the
// sweep must not re-announce every past launch to its Captain.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_agent_crew_proposal_next (
      id TEXT PRIMARY KEY,
      squadron_id TEXT NOT NULL,
      captain_participant_id TEXT NOT NULL,
      captain_thread_id TEXT NOT NULL,
      crew_instance_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('roster', 'addition')),
      status TEXT NOT NULL
        CHECK (status IN ('open', 'approving', 'declining', 'approved', 'declined')),
      brief TEXT NOT NULL,
      display_name TEXT NOT NULL,
      requested_seats TEXT NOT NULL,
      approved_seats TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      reported_at TEXT,
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    INSERT INTO j5_agent_crew_proposal_next (
      id, squadron_id, captain_participant_id, captain_thread_id, crew_instance_id, kind, status,
      brief, display_name, requested_seats, approved_seats, created_at, resolved_at, reported_at
    )
    SELECT
      id, squadron_id, captain_participant_id, captain_thread_id, crew_instance_id, kind, status,
      brief, display_name, requested_seats, approved_seats, created_at, resolved_at,
      CASE WHEN status = 'approved' THEN resolved_at ELSE NULL END
    FROM j5_agent_crew_proposal
  `;
  yield* sql`DROP TABLE j5_agent_crew_proposal`;
  yield* sql`ALTER TABLE j5_agent_crew_proposal_next RENAME TO j5_agent_crew_proposal`;
  yield* sql`
    CREATE INDEX j5_agent_crew_proposal_open_idx
    ON j5_agent_crew_proposal(status, created_at)
  `;
});

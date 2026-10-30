import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The Inbox approval an archive files for the worktrees it kept with unfinished work: one row per
 * item, its worktrees (as measured, then as decided) in `entries_json`. An item is open until
 * `decided_at` is set, and a Crew has at most one item, open or decided, so an archive that runs
 * again after "Keep all" files nothing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_crew_worktree_cleanup (
      id TEXT PRIMARY KEY,
      crew_instance_id TEXT NOT NULL,
      crew_name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      captain_thread_id TEXT NOT NULL,
      filed_at TEXT NOT NULL,
      decided_at TEXT,
      entries_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX j5_crew_worktree_cleanup_crew
    ON j5_crew_worktree_cleanup (crew_instance_id)
  `;
});

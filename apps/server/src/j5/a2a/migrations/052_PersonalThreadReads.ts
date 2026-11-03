import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_thread_read (
      person_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      last_visited_at TEXT NOT NULL,
      PRIMARY KEY (person_id, thread_id)
    )
  `;
  yield* sql`
    CREATE TABLE j5_thread_read_command (
      person_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      last_visited_at TEXT NOT NULL,
      PRIMARY KEY (person_id, command_id)
    )
  `;
  const tables = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
  `;
  if (tables.length === 0) return;
  // Preserve the first owner's existing view; other people's earlier visits were not recorded.
  yield* sql`
    INSERT INTO j5_thread_read (person_id, thread_id, last_visited_at)
    SELECT person.person_id, thread.thread_id, json_extract(thread.payload_json, '$.lastVisitedAt')
    FROM j5_a2a_human_person AS person
    CROSS JOIN orchestration_v2_projection_threads AS thread
    WHERE person.is_local_operator = 1 AND thread.deleted_at IS NULL
      AND json_extract(thread.payload_json, '$.lastVisitedAt') IS NOT NULL
  `;
});

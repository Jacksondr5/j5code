import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * When upstream settled a person's answer to a prompt, kept here because upstream prunes the event
 * that shows it (pingdotgg/t3code#29806). Backfilled from that event while the log still holds it;
 * this lane runs at startup, before any prune.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_a2a_prompt_answer ADD COLUMN settled_at TEXT`;
  // The lane also runs on databases with no upstream tables, J5's own tests among them.
  const log = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_events'
  `;
  if (log.length === 0) return;
  yield* sql`
    UPDATE j5_a2a_prompt_answer AS answer
    SET settled_at = (
      SELECT MIN(event.occurred_at) FROM orchestration_events AS event
      WHERE event.command_id = answer.command_id
        AND event.aggregate_kind = 'thread'
        AND event.stream_id = answer.thread_id
        AND event.event_type = 'runtime-request.updated'
        AND json_extract(event.payload_json, '$.id') = answer.request_id
    )
  `;
});

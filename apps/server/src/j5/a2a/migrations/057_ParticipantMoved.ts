import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// An agent moves to another project when upstream moves its thread (Turn into project). The
// event log is rebuilt to widen its CHECK for that fact, no row changed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const indexes = yield* sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'j5_a2a_comm_event' AND sql IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE j5_a2a_comm_event_moved_new (
      seq INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'exchange.opened',
        'message.sent',
        'message.received',
        'message.delivered',
        'message.delivery_failed',
        'message.cancelled',
        'message.edited',
        'exchange.closed',
        'exchange.dropped',
        'silence.notice',
        'participant.joined',
        'participant.left',
        'participant.archived',
        'participant.unarchived',
        'participant.deleted',
        'participant.moved'
      )),
      sender TEXT,
      receiver TEXT,
      exchange_id TEXT,
      correlation_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      command_id TEXT,
      PRIMARY KEY (project_id, seq),
      FOREIGN KEY (project_id) REFERENCES j5_a2a_project_ledger(project_id) ON DELETE RESTRICT,
      CHECK (kind <> 'message.received' OR correlation_id IS NOT NULL)
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_comm_event_moved_new (
      seq, project_id, kind, sender, receiver, exchange_id, correlation_id, payload, created_at,
      command_id
    )
    SELECT
      seq, project_id, kind, sender, receiver, exchange_id, correlation_id, payload, created_at,
      command_id
    FROM j5_a2a_comm_event
  `;
  yield* sql`DROP TABLE j5_a2a_comm_event`;
  yield* sql`ALTER TABLE j5_a2a_comm_event_moved_new RENAME TO j5_a2a_comm_event`;
  for (const index of indexes) {
    yield* sql.unsafe(index.sql);
  }
});

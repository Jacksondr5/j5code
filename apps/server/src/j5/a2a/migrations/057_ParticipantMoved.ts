import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// An agent moves to another project when upstream moves its thread (Turn into project). The
// event log is rebuilt to widen its CHECK for that fact, no row changed, and the reads that
// find an agent wherever it now lives get indexes.
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
  // A thread's home lookup reads its moves as it reads its join, through an index.
  yield* sql`
    CREATE INDEX j5_a2a_comm_event_moved_thread_idx
    ON j5_a2a_comm_event(json_extract(payload, '$.participant.threadId'))
    WHERE kind = 'participant.moved'
  `;
  // Finding a participant by id, such as a send to one this server has no membership for, reads
  // its joins and moves through indexes too.
  yield* sql`
    CREATE INDEX j5_a2a_comm_event_joined_participant_idx
    ON j5_a2a_comm_event(json_extract(payload, '$.participant.id'))
    WHERE kind = 'participant.joined'
  `;
  yield* sql`
    CREATE INDEX j5_a2a_comm_event_moved_participant_idx
    ON j5_a2a_comm_event(json_extract(payload, '$.participant.id'))
    WHERE kind = 'participant.moved'
  `;
  // A participant has one membership wherever it lives, so delivery finds it by id alone.
  yield* sql`CREATE INDEX j5_a2a_membership_participant_idx ON j5_a2a_membership(participant_id)`;
});

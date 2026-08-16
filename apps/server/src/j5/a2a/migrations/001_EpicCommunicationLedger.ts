import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE epic (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE comm_event (
      seq INTEGER NOT NULL,
      epic_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'exchange.opened',
        'message.sent',
        'message.received',
        'message.delivered',
        'message.delivery_failed',
        'exchange.closed',
        'silence.notice',
        'participant.joined',
        'participant.left'
      )),
      sender TEXT,
      receiver TEXT,
      exchange_id TEXT,
      correlation_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (epic_id, seq),
      FOREIGN KEY (epic_id) REFERENCES epic(id) ON DELETE RESTRICT,
      CHECK (kind <> 'message.received' OR correlation_id IS NOT NULL)
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX comm_event_received_correlation_idx
    ON comm_event(epic_id, correlation_id)
    WHERE kind = 'message.received'
  `;

  yield* sql`
    CREATE TABLE comm_command_receipt (
      command_id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL,
      command_type TEXT NOT NULL CHECK (command_type = 'comm.append'),
      accepted_at TEXT NOT NULL,
      result_seq INTEGER NOT NULL CHECK (result_seq > 0),
      FOREIGN KEY (epic_id) REFERENCES epic(id) ON DELETE RESTRICT
    )
  `;
  yield* sql`
    CREATE INDEX comm_command_receipt_epic_seq_idx
    ON comm_command_receipt(epic_id, result_seq)
  `;

  yield* sql`
    CREATE TABLE epic_membership (
      epic_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      participant_kind TEXT NOT NULL CHECK (participant_kind IN ('agent', 'human')),
      thread_id TEXT,
      joined_seq INTEGER NOT NULL,
      updated_seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (epic_id, participant_id),
      FOREIGN KEY (epic_id) REFERENCES epic(id) ON DELETE CASCADE,
      CHECK (
        (participant_kind = 'human' AND participant_id = 'human:global' AND thread_id IS NULL)
        OR
        (participant_kind = 'agent' AND thread_id IS NOT NULL)
      )
    )
  `;
});

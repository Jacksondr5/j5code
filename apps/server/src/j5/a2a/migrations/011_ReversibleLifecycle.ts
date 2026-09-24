import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE j5_a2a_lifecycle_processed (event_id TEXT PRIMARY KEY)`;
  // Existing participant.left facts remain permanent retirement. Only the new
  // archive vocabulary can restore visibility, and it never recreates membership.
  yield* sql`ALTER TABLE j5_a2a_squadron_membership ADD COLUMN archived_at TEXT`;
  yield* sql`
    CREATE TABLE j5_a2a_delivery_lifecycle_new (
      squadron_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      sent_seq INTEGER NOT NULL,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      receiver_squadron_id TEXT NOT NULL,
      exchange_id TEXT,
      exchange_role TEXT NOT NULL CHECK (exchange_role IN (
        'none',
        'ask',
        'followup',
        'reply',
        'terminal_notice'
      )),
      correlation_id TEXT NOT NULL,
      message_text TEXT NOT NULL CHECK (length(message_text) > 0),
      status TEXT NOT NULL CHECK (status IN (
        'pending',
        'retry_scheduled',
        'delivered',
        'alarmed', 'cancelled'
      )),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      next_attempt_at TEXT,
      delivered_seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      envelope_channel TEXT NOT NULL CHECK (envelope_channel IN (
        'peer',
        'silence_notice',
        'lifecycle_notice'
      )),
      PRIMARY KEY (squadron_id, message_id),
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_delivery_lifecycle_new (
      squadron_id,
      message_id,
      command_id,
      sent_seq,
      sender_id,
      receiver_id,
      receiver_squadron_id,
      exchange_id,
      exchange_role,
      correlation_id,
      message_text,
      status,
      attempts,
      last_error,
      next_attempt_at,
      delivered_seq,
      created_at,
      updated_at,
      envelope_channel
    )
    SELECT
      squadron_id,
      message_id,
      command_id,
      sent_seq,
      sender_id,
      receiver_id,
      receiver_squadron_id,
      exchange_id,
      exchange_role,
      correlation_id,
      message_text,
      status,
      attempts,
      last_error,
      next_attempt_at,
      delivered_seq,
      created_at,
      updated_at,
      envelope_channel
    FROM j5_a2a_delivery
  `;
  yield* sql`DROP TABLE j5_a2a_delivery`;
  yield* sql`ALTER TABLE j5_a2a_delivery_lifecycle_new RENAME TO j5_a2a_delivery`;
  yield* sql`
    CREATE INDEX j5_a2a_delivery_drain_idx
    ON j5_a2a_delivery(status, next_attempt_at, sent_seq)
  `;
  yield* sql`
    CREATE INDEX j5_a2a_delivery_message_sender_idx
    ON j5_a2a_delivery(message_id, sender_id)
  `;
  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_delivery_one_reply_idx
    ON j5_a2a_delivery(exchange_id)
    WHERE exchange_id IS NOT NULL AND exchange_role = 'reply'
  `;

  yield* sql`
    CREATE TABLE j5_a2a_comm_event_lifecycle_new (
      seq INTEGER NOT NULL,
      squadron_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'exchange.opened',
        'message.sent',
        'message.received',
        'message.delivered',
        'message.delivery_failed',
        'exchange.closed',
        'exchange.dropped',
        'silence.notice',
        'participant.joined',
        'participant.left', 'participant.archived', 'participant.unarchived', 'participant.deleted', 'message.cancelled'
      )),
      sender TEXT,
      receiver TEXT,
      exchange_id TEXT,
      correlation_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      command_id TEXT,
      PRIMARY KEY (squadron_id, seq),
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE RESTRICT,
      CHECK (kind <> 'message.received' OR correlation_id IS NOT NULL)
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_comm_event_lifecycle_new (
      seq,
      squadron_id,
      kind,
      sender,
      receiver,
      exchange_id,
      correlation_id,
      payload,
      created_at,
      command_id
    )
    SELECT
      seq,
      squadron_id,
      kind,
      sender,
      receiver,
      exchange_id,
      correlation_id,
      payload,
      created_at,
      command_id
    FROM j5_a2a_comm_event
  `;
  yield* sql`DROP TABLE j5_a2a_comm_event`;
  yield* sql`ALTER TABLE j5_a2a_comm_event_lifecycle_new RENAME TO j5_a2a_comm_event`;
  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_comm_event_received_correlation_idx
    ON j5_a2a_comm_event(squadron_id, correlation_id)
    WHERE kind = 'message.received'
  `;
  yield* sql`
    CREATE INDEX j5_a2a_comm_event_command_idx
    ON j5_a2a_comm_event(command_id, squadron_id, seq)
    WHERE command_id IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_comm_event_agent_home_thread_idx
    ON j5_a2a_comm_event(json_extract(payload, '$.participant.threadId'))
    WHERE kind = 'participant.joined'
      AND json_extract(payload, '$.participant.kind') = 'agent'
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The exchange projection becomes terminal at Dropped. Foreign-key checks
  // are deferred while the table is replaced so A4's human-inbox projection
  // keeps referencing the stable table name. A9 never derives or edits its
  // fields; the opaque snapshot below only defeats the parent's cascade.
  yield* sql`PRAGMA defer_foreign_keys = ON`;
  const humanInboxTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'j5_a2a_human_inbox'
  `;
  const hasHumanInbox = humanInboxTables[0] !== undefined;
  if (hasHumanInbox) {
    // Dropping the parent invokes A4's ON DELETE CASCADE even when foreign-key
    // validation is deferred. Snapshot every opaque projection column so the
    // parent rebuild has no observable effect on A4-owned data.
    yield* sql`
      CREATE TEMP TABLE j5_a2a_human_inbox_lifecycle_snapshot AS
      SELECT
        person_id,
        squadron_id,
        exchange_id,
        sender_id,
        intent,
        urgency,
        latest_message_id,
        latest_message,
        opened_seq,
        opened_at,
        status,
        terminal_seq,
        terminal_at,
        terminal_disposition,
        terminal_cause,
        terminal_facts,
        terminal_notice_message_id
      FROM j5_a2a_human_inbox
    `;
  }
  yield* sql`
    CREATE TABLE j5_a2a_exchange_lifecycle_new (
      squadron_id TEXT NOT NULL,
      exchange_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'dropped')),
      intent TEXT NOT NULL CHECK (length(trim(intent)) > 0),
      urgency TEXT CHECK (urgency IN ('blocking', 'soon', 'fyi')),
      opened_seq INTEGER NOT NULL,
      closed_seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (squadron_id, exchange_id),
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_exchange_lifecycle_new (
      squadron_id,
      exchange_id,
      sender_id,
      receiver_id,
      status,
      intent,
      urgency,
      opened_seq,
      closed_seq,
      created_at,
      updated_at
    )
    SELECT
      squadron_id,
      exchange_id,
      sender_id,
      receiver_id,
      status,
      intent,
      urgency,
      opened_seq,
      closed_seq,
      created_at,
      updated_at
    FROM j5_a2a_exchange
  `;
  yield* sql`DROP TABLE j5_a2a_exchange`;
  yield* sql`ALTER TABLE j5_a2a_exchange_lifecycle_new RENAME TO j5_a2a_exchange`;
  if (hasHumanInbox) {
    yield* sql`
      INSERT INTO j5_a2a_human_inbox (
        person_id,
        squadron_id,
        exchange_id,
        sender_id,
        intent,
        urgency,
        latest_message_id,
        latest_message,
        opened_seq,
        opened_at,
        status,
        terminal_seq,
        terminal_at,
        terminal_disposition,
        terminal_cause,
        terminal_facts,
        terminal_notice_message_id
      )
      SELECT
        person_id,
        squadron_id,
        exchange_id,
        sender_id,
        intent,
        urgency,
        latest_message_id,
        latest_message,
        opened_seq,
        opened_at,
        status,
        terminal_seq,
        terminal_at,
        terminal_disposition,
        terminal_cause,
        terminal_facts,
        terminal_notice_message_id
      FROM j5_a2a_human_inbox_lifecycle_snapshot
    `;
    yield* sql`DROP TABLE j5_a2a_human_inbox_lifecycle_snapshot`;
  }
  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_exchange_open_pair_idx
    ON j5_a2a_exchange(squadron_id, sender_id, receiver_id)
    WHERE status = 'open'
  `;
  yield* sql`
    CREATE INDEX j5_a2a_exchange_id_idx
    ON j5_a2a_exchange(exchange_id)
  `;

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
        'alarmed'
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
        'participant.left'
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

  yield* sql`
    CREATE TABLE j5_a2a_lifecycle_cursor (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      after_sequence INTEGER NOT NULL DEFAULT 0 CHECK (after_sequence >= 0),
      updated_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_lifecycle_cursor (singleton, after_sequence, updated_at)
    VALUES (1, 0, NULL)
  `;
});

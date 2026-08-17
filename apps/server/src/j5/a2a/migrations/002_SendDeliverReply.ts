import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE j5_a2a_comm_event ADD COLUMN command_id TEXT`;
  yield* sql`
    CREATE INDEX j5_a2a_comm_event_command_idx
    ON j5_a2a_comm_event(command_id, epic_id, seq)
    WHERE command_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE j5_a2a_exchange (
      epic_id TEXT NOT NULL,
      exchange_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
      intent TEXT NOT NULL CHECK (length(trim(intent)) > 0),
      urgency TEXT CHECK (urgency IN ('blocking', 'soon', 'fyi')),
      opened_seq INTEGER NOT NULL,
      closed_seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (epic_id, exchange_id),
      FOREIGN KEY (epic_id) REFERENCES j5_a2a_epic(id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_exchange_open_pair_idx
    ON j5_a2a_exchange(epic_id, sender_id, receiver_id)
    WHERE status = 'open'
  `;

  yield* sql`
    CREATE TABLE j5_a2a_delivery (
      epic_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      sent_seq INTEGER NOT NULL,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      receiver_epic_id TEXT NOT NULL,
      exchange_id TEXT,
      exchange_role TEXT NOT NULL CHECK (exchange_role IN ('none', 'ask', 'followup', 'reply')),
      correlation_id TEXT NOT NULL,
      message_text TEXT NOT NULL CHECK (length(message_text) > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'retry_scheduled', 'delivered', 'alarmed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      next_attempt_at TEXT,
      delivered_seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (epic_id, message_id),
      FOREIGN KEY (epic_id) REFERENCES j5_a2a_epic(id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX j5_a2a_delivery_drain_idx
    ON j5_a2a_delivery(status, next_attempt_at, sent_seq)
  `;
  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_delivery_one_reply_idx
    ON j5_a2a_delivery(exchange_id)
    WHERE exchange_id IS NOT NULL AND exchange_role = 'reply'
  `;

  yield* sql`
    CREATE TABLE j5_a2a_human_inbox_data (
      origin_epic_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      exchange_id TEXT,
      sender_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (origin_epic_id, message_id),
      FOREIGN KEY (origin_epic_id) REFERENCES j5_a2a_epic(id) ON DELETE CASCADE
    )
  `;
});

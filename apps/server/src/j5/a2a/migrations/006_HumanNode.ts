import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Historical homes had one implicit human. Preserve that data as one explicit
// person key; runtime code gives this id no singleton or broadcast semantics.
const LEGACY_PERSON_ID = "human:legacy-person";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE j5_a2a_comm_event
    SET
      sender = CASE WHEN sender = 'human:global' THEN ${LEGACY_PERSON_ID} ELSE sender END,
      receiver = CASE WHEN receiver = 'human:global' THEN ${LEGACY_PERSON_ID} ELSE receiver END,
      payload = CASE
        WHEN kind IN ('participant.joined', 'participant.left')
          AND json_extract(payload, '$.participant.kind') = 'human'
        THEN json_set(payload, '$.participant.id', ${LEGACY_PERSON_ID})
        ELSE payload
      END
    WHERE sender = 'human:global'
      OR receiver = 'human:global'
      OR (
        kind IN ('participant.joined', 'participant.left')
        AND json_extract(payload, '$.participant.kind') = 'human'
      )
  `;

  yield* sql`
    CREATE TABLE j5_a2a_squadron_membership_person_scoped (
      squadron_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      participant_kind TEXT NOT NULL CHECK (participant_kind IN ('agent', 'human')),
      thread_id TEXT,
      joined_seq INTEGER NOT NULL,
      updated_seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (squadron_id, participant_id),
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE,
      CHECK (
        (
          participant_kind = 'human'
          AND participant_id LIKE 'human:%'
          AND participant_id <> 'human:global'
          AND length(substr(participant_id, length('human:') + 1)) > 0
          AND thread_id IS NULL
        )
        OR
        (participant_kind = 'agent' AND thread_id IS NOT NULL)
      )
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_squadron_membership_person_scoped (
      squadron_id,
      participant_id,
      participant_kind,
      thread_id,
      joined_seq,
      updated_seq,
      payload
    )
    SELECT
      squadron_id,
      CASE WHEN participant_id = 'human:global' THEN ${LEGACY_PERSON_ID} ELSE participant_id END,
      participant_kind,
      thread_id,
      joined_seq,
      updated_seq,
      CASE
        WHEN participant_kind = 'human'
        THEN json_set(payload, '$.id', ${LEGACY_PERSON_ID})
        ELSE payload
      END
    FROM j5_a2a_squadron_membership
  `;
  yield* sql`DROP TABLE j5_a2a_squadron_membership`;
  yield* sql`
    ALTER TABLE j5_a2a_squadron_membership_person_scoped
    RENAME TO j5_a2a_squadron_membership
  `;

  yield* sql`
    UPDATE j5_a2a_exchange
    SET
      sender_id = CASE
        WHEN sender_id = 'human:global' THEN ${LEGACY_PERSON_ID}
        ELSE sender_id
      END,
      receiver_id = CASE
        WHEN receiver_id = 'human:global' THEN ${LEGACY_PERSON_ID}
        ELSE receiver_id
      END
    WHERE sender_id = 'human:global' OR receiver_id = 'human:global'
  `;
  yield* sql`
    UPDATE j5_a2a_delivery
    SET
      sender_id = CASE
        WHEN sender_id = 'human:global' THEN ${LEGACY_PERSON_ID}
        ELSE sender_id
      END,
      receiver_id = CASE
        WHEN receiver_id = 'human:global' THEN ${LEGACY_PERSON_ID}
        ELSE receiver_id
      END
    WHERE sender_id = 'human:global' OR receiver_id = 'human:global'
  `;

  yield* sql`
    CREATE TABLE j5_a2a_human_inbox_data_person_scoped (
      origin_squadron_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      exchange_id TEXT,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL CHECK (
        receiver_id LIKE 'human:%'
        AND receiver_id <> 'human:global'
        AND length(substr(receiver_id, length('human:') + 1)) > 0
      ),
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (origin_squadron_id, message_id),
      FOREIGN KEY (origin_squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    INSERT INTO j5_a2a_human_inbox_data_person_scoped (
      origin_squadron_id,
      message_id,
      exchange_id,
      sender_id,
      receiver_id,
      payload,
      created_at
    )
    SELECT
      inbox.origin_squadron_id,
      inbox.message_id,
      inbox.exchange_id,
      CASE
        WHEN inbox.sender_id = 'human:global' THEN ${LEGACY_PERSON_ID}
        ELSE inbox.sender_id
      END,
      COALESCE(exchange.receiver_id, ${LEGACY_PERSON_ID}),
      inbox.payload,
      inbox.created_at
    FROM j5_a2a_human_inbox_data AS inbox
    LEFT JOIN j5_a2a_exchange AS exchange
      ON exchange.squadron_id = inbox.origin_squadron_id
     AND exchange.exchange_id = inbox.exchange_id
  `;
  yield* sql`DROP TABLE j5_a2a_human_inbox_data`;
  yield* sql`
    ALTER TABLE j5_a2a_human_inbox_data_person_scoped
    RENAME TO j5_a2a_human_inbox_data
  `;

  // A4 exclusively owns this projection. Lifecycle lanes append terminal
  // ledger facts; A4 projects those facts into status and retained history.
  yield* sql`
    CREATE TABLE j5_a2a_human_inbox (
      person_id TEXT NOT NULL CHECK (
        person_id LIKE 'human:%'
        AND person_id <> 'human:global'
        AND length(substr(person_id, length('human:') + 1)) > 0
      ),
      squadron_id TEXT NOT NULL,
      exchange_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      urgency TEXT NOT NULL CHECK (urgency IN ('blocking', 'soon', 'fyi')),
      latest_message_id TEXT NOT NULL,
      latest_message TEXT NOT NULL,
      opened_seq INTEGER NOT NULL,
      opened_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'dropped')),
      terminal_seq INTEGER,
      terminal_at TEXT,
      terminal_disposition TEXT,
      terminal_cause TEXT,
      terminal_facts TEXT,
      terminal_notice_message_id TEXT,
      PRIMARY KEY (person_id, squadron_id, exchange_id),
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE,
      FOREIGN KEY (squadron_id, exchange_id)
        REFERENCES j5_a2a_exchange(squadron_id, exchange_id) ON DELETE CASCADE,
      CHECK (
        (status = 'open' AND terminal_seq IS NULL AND terminal_at IS NULL)
        OR
        (status <> 'open' AND terminal_seq IS NOT NULL AND terminal_at IS NOT NULL)
      )
    )
  `;

  yield* sql`
    WITH ranked_messages AS (
      SELECT
        inbox.*,
        ROW_NUMBER() OVER (
          PARTITION BY inbox.origin_squadron_id, inbox.exchange_id
          ORDER BY inbox.created_at DESC, inbox.message_id DESC
        ) AS message_rank
      FROM j5_a2a_human_inbox_data AS inbox
      WHERE inbox.exchange_id IS NOT NULL
    )
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
      exchange.receiver_id,
      exchange.squadron_id,
      exchange.exchange_id,
      exchange.sender_id,
      exchange.intent,
      exchange.urgency,
      message.message_id,
      message.payload,
      exchange.opened_seq,
      exchange.created_at,
      CASE WHEN exchange.status = 'open' THEN 'open' ELSE 'answered' END,
      CASE WHEN exchange.status = 'open' THEN NULL ELSE exchange.closed_seq END,
      CASE WHEN exchange.status = 'open' THEN NULL ELSE exchange.updated_at END,
      CASE WHEN exchange.status = 'open' THEN NULL ELSE 'answered' END,
      NULL,
      NULL,
      NULL
    FROM j5_a2a_exchange AS exchange
    JOIN ranked_messages AS message
      ON message.origin_squadron_id = exchange.squadron_id
     AND message.exchange_id = exchange.exchange_id
     AND message.message_rank = 1
    WHERE exchange.receiver_id LIKE 'human:%'
      AND exchange.receiver_id <> 'human:global'
      AND exchange.urgency IS NOT NULL
  `;
});

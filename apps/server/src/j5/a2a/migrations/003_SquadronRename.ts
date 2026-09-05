import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Rename the live schema forward while migrations 001/002 remain byte-stable for existing homes.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX j5_a2a_comm_command_receipt_epic_seq_idx`;

  yield* sql`ALTER TABLE j5_a2a_epic RENAME TO j5_a2a_squadron`;
  yield* sql`ALTER TABLE j5_a2a_comm_event RENAME COLUMN epic_id TO squadron_id`;
  yield* sql`ALTER TABLE j5_a2a_comm_command_receipt RENAME COLUMN epic_id TO squadron_id`;
  yield* sql`ALTER TABLE j5_a2a_epic_membership RENAME TO j5_a2a_squadron_membership`;
  yield* sql`
    ALTER TABLE j5_a2a_squadron_membership RENAME COLUMN epic_id TO squadron_id
  `;
  yield* sql`ALTER TABLE j5_a2a_exchange RENAME COLUMN epic_id TO squadron_id`;
  yield* sql`ALTER TABLE j5_a2a_delivery RENAME COLUMN epic_id TO squadron_id`;
  yield* sql`
    ALTER TABLE j5_a2a_delivery RENAME COLUMN receiver_epic_id TO receiver_squadron_id
  `;
  yield* sql`
    ALTER TABLE j5_a2a_human_inbox_data RENAME COLUMN origin_epic_id TO origin_squadron_id
  `;

  yield* sql`
    CREATE INDEX j5_a2a_comm_command_receipt_squadron_seq_idx
    ON j5_a2a_comm_command_receipt(squadron_id, result_seq)
  `;

  yield* sql`
    UPDATE j5_a2a_comm_event
    SET payload = json_remove(
      json_set(
        json_set(
          payload,
          '$.originSquadronId',
          json_extract(payload, '$.originEpicId')
        ),
        '$.receiverSquadronId',
        json_extract(payload, '$.receiverEpicId')
      ),
      '$.originEpicId',
      '$.receiverEpicId'
    )
    WHERE kind = 'message.sent'
  `;
  yield* sql`
    UPDATE j5_a2a_comm_event
    SET payload = json_remove(
      json_set(
        payload,
        '$.originSquadronId',
        json_extract(payload, '$.originEpicId')
      ),
      '$.originEpicId'
    )
    WHERE kind = 'message.received'
  `;
});

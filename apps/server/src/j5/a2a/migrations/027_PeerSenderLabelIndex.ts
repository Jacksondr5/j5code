import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// The client identity read names a sender homed on a peer by the label its
// server sent with the latest delivery. Without this index that read scans
// every received row; with it, each unresolved sender is one indexed probe.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS j5_a2a_comm_event_received_sender_label_idx
    ON j5_a2a_comm_event (sender, created_at DESC, seq DESC)
    WHERE kind = 'message.received' AND json_extract(payload, '$.senderLabel') IS NOT NULL
  `;
});

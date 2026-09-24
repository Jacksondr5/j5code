import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Every inbound peer delivery asks whether its sender is routed to another
// server, and every send to a known remote id reads its latest route. Both
// probes seek by participant; without these indexes they scan the ledger.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS j5_a2a_delivery_peer_receiver_idx
    ON j5_a2a_delivery (receiver_id, sent_seq DESC)
    WHERE receiver_environment_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS j5_a2a_comm_event_received_sender_idx
    ON j5_a2a_comm_event (sender, seq DESC)
    WHERE kind = 'message.received' AND json_extract(payload, '$.originEnvironmentId') IS NOT NULL
  `;
});

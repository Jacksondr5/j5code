import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_comm_event_agent_home_thread_idx
    ON j5_a2a_comm_event(json_extract(payload, '$.participant.threadId'))
    WHERE kind = 'participant.joined'
      AND json_extract(payload, '$.participant.kind') = 'agent'
  `;
});

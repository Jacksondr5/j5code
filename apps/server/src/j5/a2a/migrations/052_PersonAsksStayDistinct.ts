import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** One open Exchange per pair holds between agents only; an agent may hold several with a person. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX j5_a2a_exchange_open_pair_idx`;
  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_exchange_open_pair_idx
    ON j5_a2a_exchange(project_id, sender_id, receiver_id)
    WHERE status = 'open' AND receiver_id NOT LIKE 'human:%'
  `;
});

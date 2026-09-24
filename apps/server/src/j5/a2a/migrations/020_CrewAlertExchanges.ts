import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A platform Crew failure alert is an exchange from the Captain to the person, but it is not the
 * Captain's ask: it may stay open beside one, so neither changes or blocks the other.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX j5_a2a_exchange_open_pair_idx`;
  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_exchange_open_pair_idx
    ON j5_a2a_exchange(squadron_id, sender_id, receiver_id)
    WHERE status = 'open' AND exchange_id NOT LIKE 'exchange:j5-crew-human-alert:%'
  `;
});

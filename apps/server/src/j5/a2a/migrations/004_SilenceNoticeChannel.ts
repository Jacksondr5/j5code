import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The default is the backfill: every delivery persisted before A3 used the
  // peer envelope path. New writes always supply the channel explicitly.
  yield* sql`
    ALTER TABLE j5_a2a_delivery
    ADD COLUMN envelope_channel TEXT NOT NULL DEFAULT 'peer'
      CHECK (envelope_channel IN ('peer', 'silence_notice'))
  `;
});

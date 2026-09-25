import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Proposals resolve once, so the claimed states are gone. A row a server left `approving` or
 * `declining` when it stopped mid-resolution goes back to the person as `open`, as the retired
 * boot sweep did for a lost approval; they can approve or decline it again. An open proposal
 * holds only what was asked for, so the gate shows the requested seats again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE j5_agent_crew_proposal
    SET status = 'open', approved_seats = NULL, resolved_at = NULL
    WHERE status IN ('approving', 'declining')
  `;
});

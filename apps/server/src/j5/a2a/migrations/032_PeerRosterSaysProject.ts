import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The peer wire names a project where it named a Squadron (peer protocol 2). A
// storing server keeps each polling peer's last roster as the JSON the peer
// sent, so the snapshots already stored carry the old field names. This renames
// them in place, so the peer's agents stay listed from the upgrade until that
// peer next sends its roster.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE j5_a2a_peer
    SET roster_json = (
      SELECT json_group_array(
        json(
          json_remove(
            json_set(
              agent.value,
              '$.projectId', json_extract(agent.value, '$.squadronId'),
              '$.projectTitle', json_extract(agent.value, '$.squadronName')
            ),
            '$.squadronId', '$.squadronName'
          )
        )
      )
      FROM json_each(j5_a2a_peer.roster_json) AS agent
    )
    WHERE roster_json IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM json_each(j5_a2a_peer.roster_json) AS agent
        WHERE json_type(agent.value, '$.squadronId') IS NOT NULL
      )
  `;
});

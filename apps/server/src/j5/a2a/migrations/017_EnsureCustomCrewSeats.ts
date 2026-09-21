import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import CustomCrewSeats from "./015_CustomCrewSeats.ts";

// Lower stack branches can apply proposal migration 16 before custom-seat migration 15 exists.
// The migrator then skips 15 forever. Repair that path without renumbering applied history or
// rebuilding a table that already permits custom seats.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly notnull: number }>`
    SELECT "notnull" FROM pragma_table_info('j5_agent_crew_member') WHERE name = 'agent_id'
  `;
  if (columns[0]?.notnull === 1) yield* CustomCrewSeats;
});

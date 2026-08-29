import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// A project is an explicit Squadron resource reference, never its identity.
// The ordinal makes the relation list-ready while v0 creation remains capped
// at exactly one reference by the future creation surface.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE j5_a2a_squadron_project_reference (
      squadron_id TEXT NOT NULL,
      project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      created_at TEXT NOT NULL,
      PRIMARY KEY (squadron_id, project_id),
      UNIQUE (squadron_id, ordinal),
      FOREIGN KEY (squadron_id) REFERENCES j5_a2a_squadron(id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX j5_a2a_squadron_project_reference_project_idx
    ON j5_a2a_squadron_project_reference(project_id, squadron_id)
  `;
});

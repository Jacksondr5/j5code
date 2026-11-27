import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A sign-in started from the desktop or mobile app goes back to it by its link scheme
// (`j5code`, or a channel's such as `j5code-dev`), with the pairing link it opens.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_identity_sign_in ADD COLUMN app_scheme TEXT`;
});

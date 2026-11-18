import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A client connection's human principal, bound to the command that writes a message.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE j5_human_message_command (
      command_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      settings_write INTEGER NOT NULL CHECK (settings_write IN (0, 1))
    )
  `;
  yield* sql`CREATE INDEX j5_human_message_command_message_idx ON j5_human_message_command(message_id)`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";

export const seedPlaybookOwners = Effect.fn(function* (owners: ReadonlyArray<string>) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const owner of owners) {
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (${owner}, 'project:playbook-test', 'Owner', 'codex', 'full-access', 'default',
      '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z', '{}')`;
  }
});

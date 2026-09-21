import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runPlaybookMigrations } from "./Migrations.ts";

it.effect("starts fresh beside workflow history and is safe to run repeatedly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE j5_workflow_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
    yield* sql`CREATE TABLE j5_workflow_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)`;
    yield* sql`INSERT INTO j5_workflow_runs VALUES ('workflow:old', 'untouched')`;
    yield* sql`INSERT INTO j5_workflow_migrations VALUES (4, '4_WorkflowCandidateWatch')`;

    yield* runPlaybookMigrations();
    yield* runPlaybookMigrations();

    assert.deepEqual(yield* sql`SELECT * FROM j5_workflow_runs`, [
      { id: "workflow:old", payload: "untouched" },
    ]);
    assert.deepEqual(yield* sql`SELECT * FROM j5_workflow_migrations`, [
      { migration_id: 4, name: "4_WorkflowCandidateWatch" },
    ]);
    assert.deepEqual(yield* sql`SELECT count(*) AS count FROM j5_playbook_runs`, [{ count: 0 }]);
    assert.deepEqual(yield* sql`SELECT count(*) AS count FROM j5_playbook_migrations`, [
      { count: 2 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

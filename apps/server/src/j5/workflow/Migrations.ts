import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE j5_workflow_runs (
    id TEXT PRIMARY KEY, squadron_id TEXT NOT NULL, revision INTEGER NOT NULL,
    status TEXT NOT NULL, payload TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX j5_workflow_runs_scope ON j5_workflow_runs(squadron_id, id)`;
  yield* sql`CREATE TABLE j5_workflow_receipts (
    command_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, run_id TEXT NOT NULL,
    payload TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE j5_workflow_history (
    run_id TEXT NOT NULL, revision INTEGER NOT NULL, command_id TEXT NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(run_id, revision)
  )`;
  yield* sql`CREATE TABLE j5_workflow_actions (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL,
    owner TEXT, lease_until INTEGER, generation INTEGER NOT NULL DEFAULT 0,
    identity TEXT, payload TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX j5_workflow_actions_pending ON j5_workflow_actions(status, run_id)`;
  yield* sql`CREATE TABLE j5_workflow_artifacts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE j5_workflow_approvals (
    run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(run_id, ordinal)
  )`;
  yield* sql`CREATE TABLE j5_workflow_attempts (
    action_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, phase TEXT NOT NULL,
    revision INTEGER NOT NULL, attempt INTEGER NOT NULL, deadline INTEGER NOT NULL
  )`;
});

const migrate = Migrator.make({});
export const runWorkflowMigrations = () =>
  migrate({
    table: "j5_workflow_migrations",
    loader: Migrator.fromRecord({ "1_PersistedPhases": initial }),
  });

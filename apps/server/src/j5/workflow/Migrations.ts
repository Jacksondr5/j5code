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

const optimized = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_workflow_runs RENAME TO j5_workflow_runs_legacy_v1`;
  yield* sql`ALTER TABLE j5_workflow_receipts RENAME TO j5_workflow_receipts_legacy_v1`;
  yield* sql`ALTER TABLE j5_workflow_history RENAME TO j5_workflow_history_legacy_v1`;
  yield* sql`ALTER TABLE j5_workflow_actions RENAME TO j5_workflow_actions_legacy_v1`;
  yield* sql`ALTER TABLE j5_workflow_artifacts RENAME TO j5_workflow_artifacts_legacy_v1`;
  yield* sql`ALTER TABLE j5_workflow_approvals RENAME TO j5_workflow_approvals_legacy_v1`;
  yield* sql`ALTER TABLE j5_workflow_attempts RENAME TO j5_workflow_attempts_legacy_v1`;

  yield* sql`CREATE TABLE j5_workflow_values (
    hash TEXT PRIMARY KEY, payload TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE j5_workflow_runs (
    creation_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    definition_id TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    definition_hash TEXT NOT NULL,
    squadron_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    phase TEXT NOT NULL,
    gate_revision INTEGER,
    activity_at INTEGER NOT NULL,
    status_priority INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    read_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE j5_workflow_receipts (
    command_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, run_id TEXT NOT NULL,
    payload TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE j5_workflow_history (
    run_id TEXT NOT NULL, revision INTEGER NOT NULL, command_id TEXT NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(run_id, revision)
  )`;
  yield* sql`CREATE TABLE j5_workflow_actions (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, phase TEXT NOT NULL,
    revision INTEGER NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL,
    kind TEXT NOT NULL, adapter TEXT NOT NULL, status TEXT NOT NULL,
    deadline INTEGER NOT NULL, input_hash TEXT NOT NULL, result_artifact_id TEXT,
    owner TEXT, lease_until INTEGER, generation INTEGER NOT NULL DEFAULT 0,
    identity TEXT
  )`;
  yield* sql`CREATE TABLE j5_workflow_artifacts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, hash TEXT NOT NULL,
    producer TEXT NOT NULL, phase TEXT NOT NULL, revision INTEGER NOT NULL,
    attempt INTEGER NOT NULL, governs_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX j5_workflow_runs_v2_global_order
    ON j5_workflow_runs(status_priority, activity_at DESC, creation_sequence DESC)`;
  yield* sql`CREATE INDEX j5_workflow_runs_v2_squadron_order
    ON j5_workflow_runs(squadron_id, status_priority, activity_at DESC, creation_sequence DESC)`;
  yield* sql`CREATE INDEX j5_workflow_runs_v2_active
    ON j5_workflow_runs(status, creation_sequence)`;
  yield* sql`CREATE INDEX j5_workflow_actions_v2_run
    ON j5_workflow_actions(run_id, id)`;
  yield* sql`CREATE INDEX j5_workflow_actions_v2_identity
    ON j5_workflow_actions(identity, run_id) WHERE identity IS NOT NULL`;
  yield* sql`CREATE INDEX j5_workflow_artifacts_v2_run
    ON j5_workflow_artifacts(run_id, id)`;
});

const migrate = Migrator.make({});
export const runWorkflowMigrations = () =>
  migrate({
    table: "j5_workflow_migrations",
    loader: Migrator.fromRecord({
      "1_PersistedPhases": initial,
      "2_OptimizedWorkflowState": optimized,
    }),
  });

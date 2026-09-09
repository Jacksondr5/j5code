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

const observations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE j5_workflow_observations (
    run_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('trigger', 'receipt', 'history')),
    recorded_at INTEGER,
    event_type TEXT,
    event_action_id TEXT,
    event_gate_revision INTEGER,
    event_artifact_hash TEXT,
    decision TEXT,
    actor TEXT,
    event_cause TEXT,
    phase TEXT,
    status TEXT,
    visit INTEGER,
    gate_revision INTEGER,
    gate_artifact_hash TEXT,
    failure_category TEXT,
    relevant_action_id TEXT,
    recovery TEXT,
    state_cause TEXT,
    approvals_count INTEGER,
    event_action_status TEXT,
    event_result_artifact_id TEXT,
    event_action_identity TEXT,
    PRIMARY KEY(run_id, revision)
  )`;

  yield* sql`INSERT INTO j5_workflow_observations(
      run_id, revision, source, recorded_at,
      event_type, event_action_id, event_gate_revision, event_artifact_hash,
      decision, actor, event_cause,
      phase, status, visit, gate_revision, gate_artifact_hash,
      failure_category, relevant_action_id, recovery, state_cause, approvals_count,
      event_action_status, event_result_artifact_id, event_action_identity
    )
    SELECT
      h.run_id,
      h.revision,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN 'receipt' ELSE 'history' END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        AND json_type(r.payload, '$.updatedAt') = 'text'
        AND strftime('%s', json_extract(r.payload, '$.updatedAt')) IS NOT NULL
        THEN CAST(strftime('%s', json_extract(r.payload, '$.updatedAt')) AS INTEGER) * 1000
          + CAST(substr(strftime('%f', json_extract(r.payload, '$.updatedAt')), 4, 3) AS INTEGER)
        ELSE NULL END,
      json_extract(h.payload, '$.type'),
      json_extract(h.payload, '$.actionId'),
      coalesce(json_extract(h.payload, '$.gateRevision'), json_extract(h.payload, '$.decision.gateRevision')),
      coalesce(json_extract(h.payload, '$.artifactHash'), json_extract(h.payload, '$.decision.artifactHash')),
      json_extract(h.payload, '$.decision.decision'),
      coalesce(json_extract(h.payload, '$.actor'), json_extract(h.payload, '$.decision.actor')),
      json_extract(h.payload, '$.cause'),
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN json_extract(r.payload, '$.phase') END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN json_extract(r.payload, '$.status') END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN (SELECT CAST(v.value AS INTEGER) FROM json_each(r.payload, '$.visits') AS v
          WHERE v.key = json_extract(r.payload, '$.phase') LIMIT 1) END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN json_extract(r.payload, '$.gate.revision') END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN json_extract(r.payload, '$.gate.artifactHash') END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN json_extract(r.payload, '$.failureCategory') END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN json_extract(r.payload, '$.relevantActionId') END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN json_extract(r.payload, '$.recovery') END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN json_extract(r.payload, '$.cause') END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN json_array_length(json_extract(r.payload, '$.approvals')) END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN (SELECT json_extract(a.value, '$.status') FROM json_each(r.payload, '$.actions') AS a
          WHERE json_extract(a.value, '$.id') = json_extract(h.payload, '$.actionId') LIMIT 1) END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN (SELECT json_extract(a.value, '$.resultArtifactId') FROM json_each(r.payload, '$.actions') AS a
          WHERE json_extract(a.value, '$.id') = json_extract(h.payload, '$.actionId') LIMIT 1) END,
      CASE WHEN r.command_id IS NOT NULL
        AND json_extract(r.payload, '$.id') = h.run_id
        AND json_extract(r.payload, '$.revision') = h.revision
        THEN (SELECT json_extract(a.value, '$.externalIdentity') FROM json_each(r.payload, '$.actions') AS a
          WHERE json_extract(a.value, '$.id') = json_extract(h.payload, '$.actionId') LIMIT 1) END
    FROM j5_workflow_history AS h
    LEFT JOIN j5_workflow_receipts AS r
      ON r.command_id = h.command_id AND r.run_id = h.run_id`;

  // Store writes actions and the resulting run before history, then writes the receipt.
  // Capturing history here freezes the applied state while keeping history and observation atomic.
  yield* sql`CREATE TRIGGER j5_workflow_history_observation
    AFTER INSERT ON j5_workflow_history
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM j5_workflow_runs WHERE id=NEW.run_id AND revision=NEW.revision
      ) THEN RAISE(ABORT, 'workflow observation requires the matching resulting run') END;
      INSERT INTO j5_workflow_observations(
        run_id, revision, source, recorded_at,
        event_type, event_action_id, event_gate_revision, event_artifact_hash,
        decision, actor, event_cause,
        phase, status, visit, gate_revision, gate_artifact_hash,
        failure_category, relevant_action_id, recovery, state_cause, approvals_count,
        event_action_status, event_result_artifact_id, event_action_identity
      )
      SELECT
        NEW.run_id, NEW.revision, 'trigger', r.activity_at,
        json_extract(NEW.payload, '$.type'),
        json_extract(NEW.payload, '$.actionId'),
        coalesce(json_extract(NEW.payload, '$.gateRevision'), json_extract(NEW.payload, '$.decision.gateRevision')),
        coalesce(json_extract(NEW.payload, '$.artifactHash'), json_extract(NEW.payload, '$.decision.artifactHash')),
        json_extract(NEW.payload, '$.decision.decision'),
        coalesce(json_extract(NEW.payload, '$.actor'), json_extract(NEW.payload, '$.decision.actor')),
        json_extract(NEW.payload, '$.cause'),
        r.phase, r.status,
        (SELECT CAST(v.value AS INTEGER) FROM json_each(r.payload, '$.visits') AS v
          WHERE v.key = r.phase LIMIT 1),
        r.gate_revision,
        json_extract(r.payload, '$.gate.artifactHash'),
        json_extract(r.payload, '$.failureCategory'),
        json_extract(r.payload, '$.relevantActionId'),
        json_extract(r.payload, '$.recovery'),
        json_extract(r.payload, '$.cause'),
        json_array_length(json_extract(r.payload, '$.approvals')),
        a.status, a.result_artifact_id, a.identity
      FROM j5_workflow_runs AS r
      LEFT JOIN j5_workflow_actions AS a
        ON a.run_id=NEW.run_id AND a.id=json_extract(NEW.payload, '$.actionId')
      WHERE r.id=NEW.run_id AND r.revision=NEW.revision;
    END`;
});

const migrate = Migrator.make({});
export const workflowMigrations = {
  "1_PersistedPhases": initial,
  "2_OptimizedWorkflowState": optimized,
  "3_WorkflowObservations": observations,
};
export const runWorkflowMigrations = () =>
  migrate({
    table: "j5_workflow_migrations",
    loader: Migrator.fromRecord(workflowMigrations),
  });

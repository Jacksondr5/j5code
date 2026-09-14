import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE j5_playbook_values (
    hash TEXT PRIMARY KEY, payload TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE j5_playbook_runs (
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
    watch_candidate INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, payload TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE j5_playbook_receipts (
    command_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, run_id TEXT NOT NULL,
    payload TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE j5_playbook_history (
    run_id TEXT NOT NULL, revision INTEGER NOT NULL, command_id TEXT NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(run_id, revision)
  )`;
  yield* sql`CREATE TABLE j5_playbook_actions (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, phase TEXT NOT NULL,
    revision INTEGER NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL,
    kind TEXT NOT NULL, adapter TEXT NOT NULL, status TEXT NOT NULL,
    deadline INTEGER NOT NULL, input_hash TEXT NOT NULL, result_artifact_id TEXT,
    owner TEXT, lease_until INTEGER, generation INTEGER NOT NULL DEFAULT 0,
    identity TEXT
  )`;
  yield* sql`CREATE TABLE j5_playbook_artifacts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, hash TEXT NOT NULL,
    producer TEXT NOT NULL, phase TEXT NOT NULL, revision INTEGER NOT NULL,
    attempt INTEGER NOT NULL, governs_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX j5_playbook_runs_v2_global_order
    ON j5_playbook_runs(status_priority, activity_at DESC, creation_sequence DESC)`;
  yield* sql`CREATE INDEX j5_playbook_runs_v2_squadron_order
    ON j5_playbook_runs(squadron_id, status_priority, activity_at DESC, creation_sequence DESC)`;
  yield* sql`CREATE INDEX j5_playbook_runs_v2_active
    ON j5_playbook_runs(status, creation_sequence)`;
  yield* sql`CREATE INDEX j5_playbook_actions_v2_run
    ON j5_playbook_actions(run_id, id)`;
  yield* sql`CREATE INDEX j5_playbook_actions_v2_identity
    ON j5_playbook_actions(identity, run_id) WHERE identity IS NOT NULL`;
  yield* sql`CREATE INDEX j5_playbook_artifacts_v2_run
    ON j5_playbook_artifacts(run_id, id)`;
  yield* sql`CREATE INDEX j5_playbook_runs_candidate_watch
    ON j5_playbook_runs(watch_candidate, creation_sequence) WHERE watch_candidate=1`;
});

const observations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE j5_playbook_observations (
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

  // Store writes actions and the resulting run before history, then writes the receipt.
  // Capturing history here freezes the applied state while keeping history and observation atomic.
  yield* sql`CREATE TRIGGER j5_playbook_history_observation
    AFTER INSERT ON j5_playbook_history
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM j5_playbook_runs WHERE id=NEW.run_id AND revision=NEW.revision
      ) THEN RAISE(ABORT, 'playbook observation requires the matching resulting run') END;
      INSERT INTO j5_playbook_observations(
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
      FROM j5_playbook_runs AS r
      LEFT JOIN j5_playbook_actions AS a
        ON a.run_id=NEW.run_id AND a.id=json_extract(NEW.payload, '$.actionId')
      WHERE r.id=NEW.run_id AND r.revision=NEW.revision;
    END`;
});

const migrate = Migrator.make({});
export const playbookMigrations = {
  "1_InitialPlaybookSchema": Effect.gen(function* () {
    yield* initial;
    yield* observations;
  }),
};
export const runPlaybookMigrations = () =>
  migrate({
    table: "j5_playbook_migrations",
    loader: Migrator.fromRecord(playbookMigrations),
  });

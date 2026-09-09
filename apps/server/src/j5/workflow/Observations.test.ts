import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  deriveTimelineRevisions,
  readBoard,
  readTimeline,
  type ObservedAction,
  type WorkflowObservation,
} from "./Observations.ts";
import { workflowMigrations } from "./Migrations.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const observed = (
  revision: number,
  fields: Partial<WorkflowObservation> = {},
): WorkflowObservation => ({
  runId: "run",
  revision,
  source: "trigger",
  recordedAt: `2026-09-09T00:00:0${revision}.000Z`,
  eventType: "event",
  eventActionId: null,
  eventGateRevision: null,
  eventArtifactHash: null,
  decision: null,
  actor: null,
  eventCause: null,
  phase: "build",
  status: "running",
  visit: 1,
  gateRevision: null,
  gateArtifactHash: null,
  failureCategory: null,
  relevantActionId: null,
  recovery: null,
  stateCause: null,
  approvalsCount: 0,
  eventActionStatus: null,
  eventResultArtifactId: null,
  eventActionIdentity: null,
  ...fields,
});

it.effect("backfills frozen receipt evidence and captures later history atomically", () =>
  Effect.gen(function* () {
    yield* workflowMigrations["1_PersistedPhases"];
    yield* workflowMigrations["2_OptimizedWorkflowState"];
    const sql = yield* SqlClient.SqlClient;
    const oldSnapshot = encodeJson({
      id: "run",
      revision: 1,
      updatedAt: "2026-04-05T06:07:08.123Z",
      phase: "build",
      status: "blocked",
      visits: { build: 2 },
      gate: null,
      failureCategory: "action_failed",
      relevantActionId: "action",
      recovery: "retry",
      cause: "then",
      approvals: [],
      actions: [
        {
          id: "action",
          status: "completed",
          resultArtifactId: "artifact",
          externalIdentity: "thread-at-event/session-at-event",
        },
      ],
    });
    const currentSnapshot = encodeJson({
      id: "run",
      revision: 2,
      phase: "build",
      status: "running",
      visits: { build: 9 },
      approvals: [],
    });
    yield* sql`INSERT INTO j5_workflow_runs(
      id, definition_id, definition_version, definition_hash, squadron_id, project_id,
      title, phase, gate_revision, activity_at, status_priority, revision, read_version, status, payload
    ) VALUES ('run', 'definition', 1, 'hash', 'squadron', 'project', 'Title', 'build',
      NULL, 9999999999999, 3, 2, 1, 'running', ${currentSnapshot})`;
    yield* sql`INSERT INTO j5_workflow_actions(
      id, run_id, phase, revision, task, attempt, kind, adapter, status,
      deadline, input_hash, result_artifact_id, identity
    ) VALUES ('action', 'run', 'build', 1, 'task', 1, 'agent', 'adapter', 'blocked',
      100, 'input', NULL, 'current-thread/current-session')`;
    yield* sql`INSERT INTO j5_workflow_history(run_id, revision, command_id, payload)
      VALUES ('run', 1, 'command-1', ${encodeJson({ type: "result", actionId: "action" })})`;
    yield* sql`INSERT INTO j5_workflow_receipts(command_id, input_hash, run_id, payload)
      VALUES ('command-1', 'input', 'run', ${oldSnapshot})`;
    yield* sql`INSERT INTO j5_workflow_history(run_id, revision, command_id, payload)
      VALUES ('run', 2, 'command-2', ${encodeJson({ type: "invalidate", cause: "submitted" })})`;
    yield* sql`INSERT INTO j5_workflow_receipts(command_id, input_hash, run_id, payload)
      VALUES ('command-2', 'input', 'run', ${encodeJson({ id: "run", revision: 99 })})`;
    yield* sql`INSERT INTO j5_workflow_history(run_id, revision, command_id, payload)
      VALUES ('missing-run', 1, 'missing-command', ${encodeJson({ type: "enter" })})`;
    yield* sql`INSERT INTO j5_workflow_history(run_id, revision, command_id, payload)
      VALUES ('invalid-time-run', 1, 'invalid-time-command', ${encodeJson({ type: "enter" })})`;
    yield* sql`INSERT INTO j5_workflow_receipts(command_id, input_hash, run_id, payload)
      VALUES ('invalid-time-command', 'input', 'invalid-time-run', ${encodeJson({
        id: "invalid-time-run",
        revision: 1,
        updatedAt: "not-a-time",
        phase: "build",
        status: "running",
        visits: { build: 1 },
        approvals: [],
        actions: [],
      })})`;

    yield* workflowMigrations["3_WorkflowObservations"];
    const backfilled = yield* sql<{
      revision: number;
      source: string;
      recordedAt: number | null;
      status: string | null;
      visit: number | null;
      actionStatus: string | null;
      artifactId: string | null;
      identity: string | null;
      eventCause: string | null;
      stateCause: string | null;
    }>`SELECT revision, source, recorded_at AS recordedAt, status, visit,
      event_action_status AS actionStatus, event_result_artifact_id AS artifactId,
      event_action_identity AS identity, event_cause AS eventCause, state_cause AS stateCause
      FROM j5_workflow_observations WHERE run_id='run' ORDER BY revision`;
    assert.deepInclude(backfilled[0]!, {
      revision: 1,
      source: "receipt",
      recordedAt: Date.parse("2026-04-05T06:07:08.123Z"),
      status: "blocked",
      visit: 2,
      actionStatus: "completed",
      artifactId: "artifact",
      identity: "thread-at-event/session-at-event",
      eventCause: null,
      stateCause: "then",
    });
    assert.deepInclude(backfilled[1]!, {
      revision: 2,
      source: "history",
      recordedAt: null,
      status: null,
      eventCause: "submitted",
      stateCause: null,
    });
    const incomplete = yield* sql<{
      runId: string;
      source: string;
      recordedAt: number | null;
      status: string | null;
    }>`SELECT run_id AS runId, source, recorded_at AS recordedAt, status
      FROM j5_workflow_observations WHERE run_id IN ('missing-run','invalid-time-run')
      ORDER BY run_id`;
    assert.deepEqual(incomplete, [
      { runId: "invalid-time-run", source: "receipt", recordedAt: null, status: "running" },
      { runId: "missing-run", source: "history", recordedAt: null, status: null },
    ]);

    const triggerSnapshot = encodeJson({
      id: "run",
      revision: 3,
      phase: "review",
      status: "blocked",
      visits: { build: 9, review: 1 },
      gate: null,
      failureCategory: "action_failed",
      relevantActionId: "action",
      recovery: "retry",
      cause: "resulting",
      approvals: [],
    });
    yield* sql`UPDATE j5_workflow_runs SET revision=3, phase='review', status='blocked',
      activity_at=4567, payload=${triggerSnapshot} WHERE id='run'`;
    yield* sql`UPDATE j5_workflow_actions SET status='blocked',
      result_artifact_id='new-artifact', identity='event-thread/event-session' WHERE id='action'`;
    yield* sql`INSERT INTO j5_workflow_history(run_id, revision, command_id, payload)
      VALUES ('run', 3, 'command-3', ${encodeJson({
        type: "block",
        actionId: "action",
        cause: "submitted cause",
      })})`;
    const captured = yield* sql<{
      source: string;
      recordedAt: number;
      eventCause: string;
      stateCause: string;
      visit: number;
      actionStatus: string;
      artifactId: string;
      identity: string;
    }>`SELECT source, recorded_at AS recordedAt, event_cause AS eventCause,
      state_cause AS stateCause, visit, event_action_status AS actionStatus,
      event_result_artifact_id AS artifactId, event_action_identity AS identity
      FROM j5_workflow_observations WHERE revision=3`;
    assert.deepEqual(captured[0], {
      source: "trigger",
      recordedAt: 4567,
      eventCause: "submitted cause",
      stateCause: "resulting",
      visit: 1,
      actionStatus: "blocked",
      artifactId: "new-artifact",
      identity: "event-thread/event-session",
    });

    yield* sql`CREATE TRIGGER reject_receipt BEFORE INSERT ON j5_workflow_receipts
      WHEN NEW.command_id='command-4' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END`;
    const failed = yield* Effect.exit(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE j5_workflow_runs SET revision=4, activity_at=5000 WHERE id='run'`;
          yield* sql`INSERT INTO j5_workflow_history(run_id, revision, command_id, payload)
            VALUES ('run', 4, 'command-4', ${encodeJson({ type: "cancel" })})`;
          yield* sql`INSERT INTO j5_workflow_receipts(command_id, input_hash, run_id, payload)
            VALUES ('command-4', 'input', 'run', '{}')`;
        }),
      ),
    );
    assert.isTrue(Exit.isFailure(failed));
    assert.equal(
      (yield* sql<{ revision: number }>`SELECT revision FROM j5_workflow_runs WHERE id='run'`)[0]!
        .revision,
      3,
    );
    assert.equal(
      (yield* sql<{ count: number }>`SELECT count(*) AS count FROM j5_workflow_observations
          WHERE run_id='run'`)[0]!.count,
      3,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it("derives corrections, accepted results, transition failures, decisions, and mismatch precedence", () => {
  const actions: ObservedAction[] = [
    {
      id: "a1",
      revision: 1,
      phase: "review",
      task: "reviewer",
      attempt: 1,
      kind: "agent",
      creationVisit: 1,
    },
    {
      id: "a2",
      revision: 2,
      phase: "review",
      task: "reviewer",
      attempt: 2,
      kind: "agent",
      creationVisit: 1,
    },
  ];
  const corrections = deriveTimelineRevisions(
    [
      observed(1, { eventType: "enter", phase: "review" }),
      observed(2, {
        eventType: "result",
        eventActionId: "a1",
        eventActionStatus: "cancelled",
        phase: "review",
      }),
    ],
    actions,
    new Map(),
    new Set([1, 2]),
  );
  assert.deepEqual(
    corrections[0]!.entries.map(({ kind }) => kind),
    ["action_correction", "action_queued"],
  );
  assert.equal(corrections[0]!.entries[0]!.replacesActionId, "a1");
  const missingTime = deriveTimelineRevisions(
    [observed(1, { eventType: "enter", recordedAt: null })],
    [],
    new Map(),
    new Set([1]),
  );
  assert.equal(missingTime[0]!.recordedAt, null);
  assert.equal(missingTime[0]!.partial, false);

  const completedAndBlocked = deriveTimelineRevisions(
    [
      observed(1, { eventType: "enter", phase: "review" }),
      observed(2, {
        eventType: "result",
        eventActionId: "a1",
        eventActionStatus: "completed",
        eventResultArtifactId: "artifact",
        eventActionIdentity: "thread/session",
        phase: "review",
        status: "blocked",
        failureCategory: "transition_unavailable",
        stateCause: "No transition",
      }),
      observed(3, {
        eventType: "result",
        eventActionId: "a1",
        eventActionStatus: "completed",
        eventResultArtifactId: "mismatch-artifact",
        status: "blocked",
        failureCategory: "definition_mismatch",
        stateCause: "Pinned definition changed",
      }),
    ],
    [actions[0]!],
    new Map([
      ["artifact", "revise"],
      ["mismatch-artifact", "approve"],
    ]),
    new Set([2, 3]),
  );
  assert.deepEqual(
    completedAndBlocked[1]!.entries.map(({ kind }) => kind),
    ["action_completed", "blocked"],
  );
  assert.equal(completedAndBlocked[1]!.entries[0]!.verdict, "revise");
  assert.deepEqual(
    completedAndBlocked[0]!.entries.map(({ kind }) => kind),
    ["blocked"],
  );

  for (const eventType of ["recover", "decision"] as const) {
    const mismatch = deriveTimelineRevisions(
      [
        observed(3, { status: "blocked" }),
        observed(4, {
          eventType,
          status: "blocked",
          failureCategory: "definition_mismatch",
          stateCause: "Pinned definition changed",
        }),
      ],
      [],
      new Map(),
      new Set([4]),
    );
    assert.deepEqual(
      mismatch[0]!.entries.map(({ kind }) => kind),
      ["blocked"],
    );
  }

  const decision = deriveTimelineRevisions(
    [
      observed(3, {
        eventType: "event",
        phase: "approval",
        status: "waiting_approval",
        gateRevision: 3,
        gateArtifactHash: "gate-hash",
        approvalsCount: 0,
      }),
      observed(4, {
        eventType: "decision",
        eventGateRevision: 3,
        eventArtifactHash: "gate-hash",
        decision: "cancel",
        actor: "human",
        phase: "approval",
        status: "cancelling",
        approvalsCount: 1,
      }),
    ],
    [],
    new Map(),
    new Set([4]),
  );
  assert.deepEqual(
    decision[0]!.entries.map(({ kind }) => kind),
    ["decision", "cancel_requested"],
  );
});

it("derives blocked, recovery, restart, gate, invalidation, cancellation, and terminal transitions", () => {
  const action: ObservedAction = {
    id: "action",
    revision: 1,
    phase: "review",
    task: "reviewer",
    attempt: 1,
    kind: "agent",
    creationVisit: 1,
  };
  const kinds = (
    previous: WorkflowObservation,
    current: WorkflowObservation,
    actions: ReadonlyArray<ObservedAction> = [action],
  ) =>
    deriveTimelineRevisions(
      [previous, current],
      actions,
      new Map(),
      new Set([current.revision]),
    )[0]!.entries.map((item) => item.kind);

  const running = observed(1, { eventType: "enter", phase: "review" });
  assert.deepEqual(
    kinds(
      running,
      observed(2, {
        eventType: "block",
        eventActionId: "action",
        eventActionStatus: "blocked",
        relevantActionId: "action",
        phase: "review",
        status: "blocked",
        failureCategory: "action_failed",
        stateCause: "provider failed",
      }),
    ),
    ["action_failed", "blocked"],
  );
  assert.deepEqual(
    kinds(
      running,
      observed(2, {
        eventType: "result",
        eventActionId: "action",
        eventActionStatus: "pending",
        relevantActionId: "action",
        phase: "review",
        status: "blocked",
        failureCategory: "action_deadline_expired",
        stateCause: "deadline",
      }),
    ),
    ["action_failed", "blocked"],
  );
  const blocked = observed(2, {
    phase: "review",
    status: "blocked",
    failureCategory: "action_failed",
  });
  assert.deepEqual(kinds(blocked, observed(3, { eventType: "retry", phase: "review" }), []), [
    "recovered",
  ]);
  assert.deepEqual(
    kinds(
      blocked,
      observed(3, { eventType: "restart_phase", phase: "review", visit: 2, status: "restarting" }),
      [],
    ),
    ["restart_requested", "phase_entered"],
  );
  const restarting = observed(3, {
    eventType: "restart_phase",
    phase: "review",
    visit: 2,
    status: "restarting",
  });
  assert.deepEqual(
    kinds(
      restarting,
      observed(4, {
        eventType: "restart_cleanup_failed",
        phase: "review",
        visit: 2,
        status: "blocked",
        failureCategory: "restart_cleanup_failed",
        stateCause: "cleanup",
      }),
      [],
    ),
    ["restart_cleanup_failed", "blocked"],
  );
  assert.deepEqual(
    kinds(
      observed(4, {
        phase: "review",
        visit: 2,
        status: "blocked",
        failureCategory: "restart_cleanup_failed",
      }),
      observed(5, { eventType: "retry_restart", phase: "review", visit: 2, status: "restarting" }),
      [],
    ),
    ["restart_requested"],
  );
  const replacement = { ...action, id: "replacement", revision: 6, creationVisit: 2 };
  assert.deepEqual(
    kinds(
      observed(5, { phase: "review", visit: 2, status: "restarting" }),
      observed(6, { eventType: "restart_ready", phase: "review", visit: 2 }),
      [replacement],
    ),
    ["restart_ready", "action_queued"],
  );
  assert.deepEqual(
    kinds(
      observed(6, {
        phase: "approval",
        status: "waiting_approval",
        gateRevision: 6,
        gateArtifactHash: "old",
      }),
      observed(7, {
        eventType: "edit_gate",
        phase: "approval",
        status: "waiting_approval",
        gateRevision: 7,
        gateArtifactHash: "new",
      }),
      [],
    ),
    ["gate_revised"],
  );
  assert.deepEqual(
    kinds(
      running,
      observed(2, { eventType: "invalidate", eventCause: "changed", phase: "plan", visit: 1 }),
      [],
    ),
    ["invalidated", "phase_entered"],
  );
  assert.deepEqual(
    kinds(running, observed(2, { eventType: "cancel", phase: "review", status: "cancelling" }), []),
    ["cancel_requested"],
  );
  assert.deepEqual(
    kinds(
      observed(2, { status: "cancelling" }),
      observed(3, { eventType: "cancelled", status: "cancelled" }),
      [],
    ),
    ["cancelled"],
  );
  assert.deepEqual(
    kinds(running, observed(2, { eventType: "result", phase: "review", status: "completed" }), []),
    ["completed", "event"],
  );
});

it.effect("reads bounded board projections and revision-disjoint timeline pages", () =>
  Effect.gen(function* () {
    yield* workflowMigrations["1_PersistedPhases"];
    yield* workflowMigrations["2_OptimizedWorkflowState"];
    yield* workflowMigrations["3_WorkflowObservations"];
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs(
      run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL,
      requested_at TEXT NOT NULL, completed_at TEXT
    )`;
    for (let revision = 1; revision <= 5; revision++) {
      const payload = encodeJson({
        id: "timeline-run",
        revision: 5,
        phase: "build",
        status: "running",
        visits: { build: 1 },
        approvals: [],
        failureCategory: null,
      });
      if (revision === 1)
        yield* sql`INSERT INTO j5_workflow_runs(
          id, definition_id, definition_version, definition_hash, squadron_id, project_id,
          title, phase, gate_revision, activity_at, status_priority, revision, read_version, status, payload
        ) VALUES ('timeline-run', 'definition', 1, 'hash', 'scope', 'project', 'Private title',
          'build', NULL, 100, 3, 5, 7, 'running', ${payload})`;
      yield* sql`INSERT INTO j5_workflow_observations(
        run_id, revision, source, recorded_at, event_type, phase, status, visit, approvals_count
      ) VALUES ('timeline-run', ${revision}, 'trigger', ${revision}, 'event', 'build',
        'running', 1, 0)`;
    }
    yield* sql`INSERT INTO j5_workflow_actions(
      id, run_id, phase, revision, task, attempt, kind, adapter, status,
      deadline, input_hash, result_artifact_id, identity
    ) VALUES
      ('agent-action', 'timeline-run', 'build', 5, 'agent-task', 1, 'agent', 'persona',
        'pending', 5000, 'secret-input', NULL, 'thread/session'),
      ('code-action', 'timeline-run', 'build', 5, 'code-task', 1, 'code', 'code',
        'blocked', 6000, 'secret-code-input', NULL, NULL)`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs(
      run_id, thread_id, status, requested_at, completed_at
    ) VALUES ('session', 'thread', 'queued', 'requested', NULL)`;
    for (let index = 0; index < 24; index++) {
      const payload = encodeJson({
        id: `board-${index}`,
        revision: 1,
        phase: "done",
        status: "completed",
        visits: { done: 1 },
        approvals: [],
      });
      yield* sql`INSERT INTO j5_workflow_runs(
        id, definition_id, definition_version, definition_hash, squadron_id, project_id,
        title, phase, gate_revision, activity_at, status_priority, revision, read_version, status, payload
      ) VALUES (${`board-${index}`}, 'definition', 1, 'hash', 'scope', 'project',
        ${`Private ${index}`}, 'done', NULL, ${index}, 5, 1, 1, 'completed', ${payload})`;
    }

    const board = yield* readBoard("scope", "private", 0, 24);
    assert.equal(board.cards.length, 24);
    assert.equal(board.total, 25);
    assert.equal(board.hasMore, true);
    assert.equal(board.cards[0]!.readVersion, 7);
    assert.equal(board.cards[0]!.visit, 1);
    assert.deepEqual(
      board.cards[0]!.actions.map((action) => action.actionKind),
      ["agent", "code"],
    );
    assert.deepInclude(board.cards[0]!.actions[0]!, {
      threadId: "thread",
      sessionRunId: "session",
      sessionStatus: "queued",
    });
    assert.deepInclude(board.cards[0]!.actions[1]!, {
      threadId: null,
      sessionRunId: null,
      sessionStatus: null,
    });
    assert.isFalse(encodeJson(board).includes("secret-input"));
    const nextBoard = yield* readBoard("scope", "private", 24, 24);
    assert.equal(nextBoard.cards.length, 1);
    assert.equal(nextBoard.hasMore, false);

    const first = yield* readTimeline("timeline-run", null, 2);
    const second = yield* readTimeline("timeline-run", first.nextBefore, 2);
    const third = yield* readTimeline("timeline-run", second.nextBefore, 2);
    const revisions = [...first.revisions, ...second.revisions, ...third.revisions].map(
      (item) => item.revision,
    );
    assert.deepEqual(revisions, [5, 4, 3, 2, 1]);
    assert.equal(new Set(revisions).size, 5);
    assert.equal(third.nextBefore, null);
    const observationPlan = yield* sql.unsafe<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT revision FROM j5_workflow_observations
        WHERE run_id=? AND revision<? ORDER BY revision DESC LIMIT ?`,
      ["timeline-run", 5, 3],
    );
    assert.isTrue(
      observationPlan.some(({ detail }) =>
        detail.includes("sqlite_autoindex_j5_workflow_observations_1"),
      ),
    );
    const actionPlan = yield* sql.unsafe<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id FROM j5_workflow_actions
        WHERE run_id IN (?) AND status IN ('pending','claimed','blocked')`,
      ["timeline-run"],
    );
    assert.isTrue(actionPlan.some(({ detail }) => detail.includes("j5_workflow_actions_v2_run")));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

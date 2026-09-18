import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  deriveTimelineRevisions,
  readBoard,
  readTimeline,
  type ObservedAction,
  type PlaybookObservation,
} from "./Observations.ts";
import { runPlaybookMigrations } from "./Migrations.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const observed = (
  revision: number,
  fields: Partial<PlaybookObservation> = {},
): PlaybookObservation => ({
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
    previous: PlaybookObservation,
    current: PlaybookObservation,
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
  const interrupted = observed(2, {
    eventType: "server_interrupted",
    phase: "review",
    status: "blocked",
    failureCategory: "server_interrupted",
    stateCause: "server stopped",
  });
  assert.deepEqual(kinds(running, interrupted, []), ["interrupted", "blocked"]);
  const resumedAction = {
    ...action,
    id: "resumed-action",
    revision: 3,
    predecessorActionId: action.id,
  };
  const resumed = deriveTimelineRevisions(
    [interrupted, observed(3, { eventType: "resume", phase: "review", status: "running" })],
    [resumedAction],
    new Map(),
    new Set([3]),
  )[0]!.entries;
  assert.deepEqual(
    resumed.map((item) => item.kind),
    ["resumed", "action_queued"],
  );
  assert.equal(resumed[1]!.replacesActionId, action.id);
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
    yield* runPlaybookMigrations();
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
        yield* sql`INSERT INTO j5_playbook_runs(
          id, definition_id, definition_version, definition_hash, squadron_id, project_id,
          title, phase, gate_revision, activity_at, status_priority, revision, read_version, status, payload
        ) VALUES ('timeline-run', 'definition', 1, 'hash', 'scope', 'project', 'Private title',
          'build', NULL, 100, 3, 5, 7, 'running', ${payload})`;
      yield* sql`INSERT INTO j5_playbook_observations(
        run_id, revision, source, recorded_at, event_type, phase, status, visit, approvals_count
      ) VALUES ('timeline-run', ${revision}, 'trigger', ${revision}, 'event', 'build',
        'running', 1, 0)`;
    }
    yield* sql`INSERT INTO j5_playbook_actions(
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
      yield* sql`INSERT INTO j5_playbook_runs(
        id, definition_id, definition_version, definition_hash, squadron_id, project_id,
        title, phase, gate_revision, activity_at, status_priority, revision, read_version, status, payload
      ) VALUES (${`board-${index}`}, 'definition', 1, 'hash', 'scope', 'project',
        ${`Private ${index}`}, 'done', NULL, ${index}, 5, 1, 1, 'completed', ${payload})`;
    }

    const board = yield* readBoard("scope", "private", 0, 24, "all");
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
    const nextBoard = yield* readBoard("scope", "private", 24, 24, "all");
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
      `EXPLAIN QUERY PLAN SELECT revision FROM j5_playbook_observations
        WHERE run_id=? AND revision<? ORDER BY revision DESC LIMIT ?`,
      ["timeline-run", 5, 3],
    );
    assert.isTrue(
      observationPlan.some(({ detail }) =>
        detail.includes("sqlite_autoindex_j5_playbook_observations_1"),
      ),
    );
    const actionPlan = yield* sql.unsafe<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id FROM j5_playbook_actions
        WHERE run_id IN (?) AND status IN ('pending','claimed','blocked')`,
      ["timeline-run"],
    );
    assert.isTrue(actionPlan.some(({ detail }) => detail.includes("j5_playbook_actions_v2_run")));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("defaults the board to ongoing runs while preserving terminal filters", () =>
  Effect.gen(function* () {
    yield* runPlaybookMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs(
      run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL,
      requested_at TEXT NOT NULL, completed_at TEXT
    )`;
    const statuses = [
      "running",
      "restarting",
      "waiting_approval",
      "blocked",
      "cancelling",
      "cancelled",
      "completed",
      "failed",
    ] as const;
    for (const [index, status] of statuses.entries()) {
      const payload = encodeJson({
        id: `run-${status}`,
        revision: 1,
        phase: "build",
        status,
        visits: { build: 1 },
        approvals: [],
      });
      yield* sql`INSERT INTO j5_playbook_runs(
        id, definition_id, definition_version, definition_hash, squadron_id, project_id,
        title, phase, gate_revision, activity_at, status_priority, revision, read_version, status, payload
      ) VALUES (${`run-${status}`}, 'definition', 1, 'hash', 'scope', 'project',
        ${status}, 'build', NULL, ${index}, ${index}, 1, 1, ${status}, ${payload})`;
    }

    const ongoing = yield* readBoard("scope", "", 0, 4);
    assert.equal(ongoing.total, 5);
    assert.equal(ongoing.cards.length, 4);
    assert.equal(ongoing.hasMore, true);
    assert.deepEqual(
      new Set(ongoing.cards.map(({ status }) => status)),
      new Set(["running", "restarting", "waiting_approval", "blocked"]),
    );
    const lastOngoing = yield* readBoard("scope", "", 4, 4);
    assert.equal(lastOngoing.total, 5);
    assert.equal(lastOngoing.cards.length, 1);
    assert.equal(lastOngoing.cards[0]!.status, "cancelling");
    assert.equal(lastOngoing.hasMore, false);

    const cancelled = yield* readBoard("scope", "", 0, 24, "cancelled");
    assert.equal(cancelled.total, 1);
    assert.deepEqual(
      cancelled.cards.map(({ status }) => status),
      ["cancelled"],
    );

    const all = yield* readBoard("scope", "", 0, 24, "all");
    assert.equal(all.total, 8);
    assert.equal(all.cards.length, 8);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

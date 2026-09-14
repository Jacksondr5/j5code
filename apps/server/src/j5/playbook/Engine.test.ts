// @effect-diagnostics nodeBuiltinImport:off - disk reopen fixture.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { Run } from "@j5/playbook-contracts";
import { decide } from "./decider.ts";
import { hash, type Definition } from "./Definition.ts";
import { runPlaybookMigrations } from "./Migrations.ts";
import { makeStore, PlaybookError } from "./Store.ts";
import { makeWorker, type Adapter } from "./Worker.ts";
import { restartPresentation } from "../playbook-definitions/Service.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const definition: Definition = {
  id: "test",
  version: 1,
  hash: "test-v1",
  initial: "agent",
  phases: [
    {
      id: "agent",
      kind: "agent",
      tasks: [{ id: "writer", adapter: "scripted" }],
      transitions: { ok: "code" },
      maxVisits: 3,
    },
    {
      id: "code",
      kind: "code",
      tasks: [{ id: "check", adapter: "scripted" }],
      transitions: { ok: "approval" },
      maxVisits: 3,
    },
    {
      id: "approval",
      kind: "gate",
      tasks: [],
      transitions: { approve: "$complete", request_changes: "agent" },
      maxVisits: 3,
    },
  ],
  input: (run) => run.inputs,
  validate: (_action, output) => {
    if (typeof output !== "string") throw new Error("Expected string");
    return output;
  },
  outcome: () => "ok",
  gateArtifacts: (run) => run.artifacts.slice(-2),
};
const initial: Run = {
  id: "run-1",
  definitionId: "test",
  definitionVersion: 1,
  definitionHash: "test-v1",
  squadronId: "squadron",
  projectId: "project",
  repository: "/sample",
  baseCommit: "abc",
  inputs: { request: "change" },
  execution: {},
  phase: "agent",
  revision: 0,
  status: "running",
  cause: null,
  recovery: null,
  gate: null,
  actions: [],
  artifacts: [],
  approvals: [],
  visits: {},
};

const reviewDefinition: Definition = {
  ...definition,
  initial: "plan_review",
  phases: [
    {
      id: "plan_review",
      kind: "agent",
      tasks: [
        { id: "advocate", adapter: "scripted" },
        { id: "skeptic", adapter: "scripted" },
      ],
      transitions: { ok: "plan_approval" },
      maxVisits: 3,
      capabilities: ["restart"],
    },
    {
      id: "plan_approval",
      kind: "gate",
      tasks: [],
      transitions: { approve: "$complete" },
      maxVisits: 3,
    },
  ],
};
const reviewInitial: Run = {
  ...initial,
  phase: "plan_review",
  definitionHash: reviewDefinition.hash,
};

it("keeps restart decisions aligned with their service presentation", () => {
  const eligible = {
    ...decide(reviewInitial, { type: "enter" }, reviewDefinition, 0),
    status: "blocked" as const,
    failureCategory: "action_deadline_expired" as const,
  };
  const cases: ReadonlyArray<{
    name: string;
    run: Run;
    definitions: ReadonlyArray<Definition>;
    decisionDefinition: Definition | undefined;
    available: boolean;
  }> = [
    {
      name: "eligible",
      run: eligible,
      definitions: [reviewDefinition],
      decisionDefinition: reviewDefinition,
      available: true,
    },
    {
      name: "wrong status",
      run: { ...eligible, status: "running" },
      definitions: [reviewDefinition],
      decisionDefinition: reviewDefinition,
      available: false,
    },
    {
      name: "wrong failure",
      run: { ...eligible, failureCategory: "action_failed" },
      definitions: [reviewDefinition],
      decisionDefinition: reviewDefinition,
      available: false,
    },
    {
      name: "missing definition",
      run: eligible,
      definitions: [],
      decisionDefinition: undefined,
      available: false,
    },
    {
      name: "changed definition",
      run: eligible,
      definitions: [],
      decisionDefinition: { ...reviewDefinition, hash: "changed" },
      available: false,
    },
    {
      name: "unsupported phase",
      run: {
        ...eligible,
        definitionHash: definition.hash,
        phase: "agent",
      },
      definitions: [definition],
      decisionDefinition: definition,
      available: false,
    },
    {
      name: "exhausted budget",
      run: { ...eligible, visits: { plan_review: 3 } },
      definitions: [reviewDefinition],
      decisionDefinition: reviewDefinition,
      available: false,
    },
  ];

  for (const testCase of cases) {
    const presentation = restartPresentation(testCase.run, testCase.definitions);
    assert.equal(presentation.available, testCase.available, testCase.name);
    let restarted = false;
    try {
      restarted =
        decide(
          testCase.run,
          {
            type: "restart_phase",
            targetDefinitionHash: testCase.run.definitionHash,
            actor: "human",
          },
          testCase.decisionDefinition,
          1,
        ).status === "restarting";
    } catch {
      restarted = false;
    }
    assert.equal(restarted, presentation.available, testCase.name);
  }
});

it("restarts timed-out reviewers with fresh identities and preserves prior evidence", () => {
  let run = decide(reviewInitial, { type: "enter" }, reviewDefinition, 0);
  const oldActions = [...run.actions];
  run = decide(
    run,
    { type: "result", actionId: oldActions[0]!.id, output: "earlier review" },
    reviewDefinition,
    1,
  );
  run = decide(
    run,
    { type: "result", actionId: oldActions[1]!.id, output: "late" },
    reviewDefinition,
    oldActions[1]!.deadline,
  );
  assert.equal(run.failureCategory, "action_deadline_expired");
  const restarting = decide(
    run,
    {
      type: "restart_phase",
      targetDefinitionHash: reviewDefinition.hash,
      actor: "human",
    },
    reviewDefinition,
    2_000_000,
  );
  assert.equal(restarting.status, "restarting");
  assert.equal(restarting.visits.plan_review, 2);
  assert.equal(restarting.restart?.visit, 2);
  assert.equal(restarting.artifacts.length, 1);
  const cancelling = decide(restarting, { type: "cancel" }, reviewDefinition, 2_000_000);
  assert.equal(cancelling.status, "cancelling");
  assert.equal(decide(cancelling, { type: "cancelled" }, undefined, 2_000_000).status, "cancelled");
  const replacement = decide(restarting, { type: "restart_ready" }, reviewDefinition, 2_000_001);
  assert.equal(replacement.status, "running");
  assert.lengthOf(replacement.actions, 4);
  assert.isTrue(
    replacement.actions
      .slice(-2)
      .every(
        (action) =>
          !oldActions.some((old) => old.id === action.id) &&
          action.externalIdentity === undefined &&
          action.deadline === 3_800_000,
      ),
  );
  assert.deepEqual(
    decide(
      replacement,
      { type: "result", actionId: oldActions[1]!.id, output: "late result" },
      reviewDefinition,
      2_000_002,
    ),
    replacement,
  );
  const one = decide(
    replacement,
    { type: "result", actionId: replacement.actions.at(-2)!.id, output: "accepted" },
    reviewDefinition,
    2_000_003,
  );
  const waiting = decide(
    one,
    { type: "result", actionId: one.actions.at(-1)!.id, output: "accepted" },
    reviewDefinition,
    2_000_004,
  );
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.artifacts.length, 3);
});

it("clears inherited correction identity while preserving its budget and deadline", () => {
  const entered = decide(reviewInitial, { type: "enter" }, reviewDefinition, 0);
  const action = { ...entered.actions[0]!, externalIdentity: "thread:old/run" };
  const withIdentity = {
    ...entered,
    actions: entered.actions.map((item) => (item.id === action.id ? action : item)),
  };
  const corrected = decide(
    withIdentity,
    { type: "result", actionId: action.id, output: 42 },
    reviewDefinition,
    1,
  );
  const next = corrected.actions.at(-1)!;
  assert.equal(next.attempt, 2);
  assert.equal(next.deadline, action.deadline);
  assert.notProperty(next, "externalIdentity");
});

it("does not grant a fourth review visit or consume another visit when cleanup is retried", () => {
  const blocked = {
    ...decide(reviewInitial, { type: "enter" }, reviewDefinition, 0),
    status: "blocked" as const,
    failureCategory: "action_deadline_expired" as const,
    visits: { plan_review: 3 },
  };
  assert.throws(() =>
    decide(
      blocked,
      {
        type: "restart_phase",
        targetDefinitionHash: reviewDefinition.hash,
        actor: "human",
      },
      reviewDefinition,
      1,
    ),
  );
  const eligible = { ...blocked, visits: { plan_review: 1 } };
  const restarting = decide(
    eligible,
    {
      type: "restart_phase",
      targetDefinitionHash: reviewDefinition.hash,
      actor: "human",
    },
    reviewDefinition,
    1,
  );
  const failed = decide(
    restarting,
    { type: "restart_cleanup_failed", cause: "interrupt failed" },
    reviewDefinition,
    2,
  );
  const retried = decide(failed, { type: "retry_restart" }, reviewDefinition, 3);
  assert.equal(retried.status, "restarting");
  assert.equal(retried.visits.plan_review, 2);
});

it.effect("persists restart cleanup, deduplicates requests, and resumes after cleanup retry", () =>
  Effect.gen(function* () {
    yield* runPlaybookMigrations();
    const store = yield* makeStore;
    const entered = yield* store.command(
      {
        commandId: "review-start",
        runId: reviewInitial.id,
        expectedRevision: 0,
        initial: reviewInitial,
        event: { type: "enter" },
        now: 0,
      },
      reviewDefinition,
    );
    const blocked = yield* store.command(
      {
        commandId: "review-timeout",
        runId: entered.id,
        expectedRevision: entered.revision,
        event: {
          type: "block",
          actionId: entered.actions[0]!.id,
          cause: "deadline elapsed",
          recovery: null,
          failureCategory: "action_deadline_expired",
        },
        now: 1_800_000,
      },
      reviewDefinition,
    );
    const restartCommand = {
      commandId: "restart-review",
      runId: blocked.id,
      expectedRevision: blocked.revision,
      event: {
        type: "restart_phase" as const,
        targetDefinitionHash: reviewDefinition.hash,
        actor: "human",
      },
      now: 2_000_000,
    };
    const restarting = yield* store.command(restartCommand, reviewDefinition);
    assert.deepEqual(yield* store.command(restartCommand, reviewDefinition), restarting);
    assert.equal((yield* store.get(restarting.id)).status, "restarting");
    const stale = yield* Effect.exit(
      store.command(
        { ...restartCommand, commandId: "stale-restart", expectedRevision: blocked.revision },
        reviewDefinition,
      ),
    );
    assert.isTrue(Exit.isFailure(stale));

    let failCleanup = true;
    const interrupted: string[] = [];
    const adapter: Adapter = {
      recovery: "reconcile",
      interrupt: (action) =>
        Effect.gen(function* () {
          interrupted.push(action.id);
          if (failCleanup) {
            failCleanup = false;
            return yield* new PlaybookError({ code: "invalid", detail: "interrupt unavailable" });
          }
        }),
      reconcile: () => Effect.succeed({ status: "completed", output: "accepted" }),
    };
    const worker = makeWorker(store, [reviewDefinition], { scripted: adapter }, "restart-worker");
    yield* worker.drain(2_000_001);
    const cleanupFailed = yield* store.get(restarting.id);
    assert.equal(cleanupFailed.recovery, "retry_restart");
    assert.equal(cleanupFailed.visits.plan_review, 2);
    const retrying = yield* store.command(
      {
        commandId: "retry-cleanup",
        runId: cleanupFailed.id,
        expectedRevision: cleanupFailed.revision,
        event: { type: "retry_restart" },
        now: 2_000_002,
      },
      reviewDefinition,
    );
    yield* worker.drain(2_000_003);
    const waiting = yield* store.get(retrying.id);
    assert.equal(waiting.status, "waiting_approval");
    assert.equal(waiting.visits.plan_review, 2);
    assert.lengthOf(waiting.actions, 4);
    assert.isAtLeast(interrupted.length, 2);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it("waits for every reviewer and exhausts the revision budget without bypass", () => {
  const reviews: Definition = {
    ...definition,
    phases: [
      {
        id: "agent",
        kind: "agent",
        tasks: [
          { id: "one", adapter: "scripted" },
          { id: "two", adapter: "scripted" },
        ],
        transitions: { ok: "agent" },
        maxVisits: 3,
      },
    ],
  };
  let run = decide(initial, { type: "enter" }, reviews, 0);
  for (let round = 0; round < 3; round++) {
    const tasks = run.actions.slice(-2);
    run = decide(run, { type: "result", actionId: tasks[0]!.id, output: "review one" }, reviews, 1);
    assert.equal(run.visits.agent, round + 1);
    assert.equal(run.status, "running");
    run = decide(run, { type: "result", actionId: tasks[1]!.id, output: "review two" }, reviews, 2);
  }
  assert.equal(run.status, "blocked");
  assert.equal(run.failureCategory, "revision_budget_exhausted");
  assert.match(run.cause!, /budget exhausted/);
  assert.lengthOf(run.actions, 6);
});

it.effect("reopens a populated database with the same pending intent and start receipt", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j5-reopen-")),
    );
    const filename = NodePath.join(directory, "state.sqlite");
    const command = {
      commandId: "disk-start",
      runId: initial.id,
      expectedRevision: 0,
      initial,
      event: { type: "enter" as const },
      now: 0,
    };
    const started = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* runPlaybookMigrations();
        return yield* (yield* makeStore).command(command, definition);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
    const recovered = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* runPlaybookMigrations();
        return yield* (yield* makeStore).command(command, definition);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
    assert.deepStrictEqual(recovered, started);
  }),
);

it.effect("writes only the changed result state regardless of persisted action history", () =>
  Effect.gen(function* () {
    yield* runPlaybookMigrations();
    const store = yield* makeStore;
    const sql = yield* SqlClient.SqlClient;
    const measuredDefinition: Definition = {
      ...definition,
      phases: [
        {
          id: "agent",
          kind: "agent",
          tasks: [
            { id: "measured", adapter: "scripted" },
            { id: "pending", adapter: "scripted" },
          ],
          transitions: { ok: "$complete" },
          maxVisits: 1,
        },
      ],
    };

    for (const count of [10, 30, 100]) {
      const id = `history-${count}`;
      const historicalArtifacts = Array.from({ length: count }, (_, index) => {
        const content = { historical: index };
        return {
          id: `${id}:artifact:${index}`,
          hash: hash(content),
          content,
          producer: "history",
          phase: "history",
          revision: index,
          attempt: 1,
          governs: [],
        };
      });
      const historicalActions = historicalArtifacts.map((artifact, index) => ({
        id: `${id}:action:${index}`,
        runId: id,
        phase: "history",
        revision: index,
        task: `history-${index}`,
        attempt: 1,
        kind: "agent" as const,
        adapter: "scripted",
        status: "completed" as const,
        deadline: 10_000,
        input: { historicalInput: index },
        resultArtifactId: artifact.id,
      }));
      const fixture = {
        ...initial,
        id,
        actions: historicalActions,
        artifacts: historicalArtifacts,
      } satisfies Run;
      const started = yield* store.command(
        {
          commandId: `${id}:start`,
          runId: id,
          expectedRevision: 0,
          initial: fixture,
          event: { type: "enter" },
          now: 0,
        },
        measuredDefinition,
      );
      assert.lengthOf(started.actions, count + 2);
      assert.lengthOf(started.artifacts, count);

      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") statements.push(query.trim());
          };
          return span;
        },
      });
      const command = {
        commandId: `${id}:result`,
        runId: id,
        expectedRevision: started.revision,
        event: {
          type: "result" as const,
          actionId: started.actions.at(-2)!.id,
          output: "measured",
        },
        now: 1,
      };
      const result = yield* store
        .command(command, measuredDefinition)
        .pipe(Effect.withTracer(tracer));

      const countStatements = (prefix: string) =>
        statements.filter((statement) => statement.startsWith(prefix)).length;
      assert.equal(countStatements("INSERT OR IGNORE INTO j5_playbook_values"), 1, `${count}`);
      assert.equal(countStatements("INSERT INTO j5_playbook_actions"), 1, `${count}`);
      assert.equal(countStatements("INSERT OR IGNORE INTO j5_playbook_artifacts"), 1, `${count}`);
      assert.deepEqual(yield* store.get(id), result);
      assert.deepEqual(
        yield* sql`SELECT revision, read_version AS readVersion FROM j5_playbook_runs WHERE id=${id}`,
        [{ revision: 2, readVersion: 2 }],
      );
      assert.deepEqual(
        yield* sql`SELECT count(*) AS count FROM j5_playbook_history WHERE run_id=${id}`,
        [{ count: 2 }],
      );
      assert.deepEqual(
        yield* sql`SELECT count(*) AS count FROM j5_playbook_receipts WHERE run_id=${id}`,
        [{ count: 2 }],
      );
      assert.deepEqual(
        yield* sql`SELECT count(*) AS count FROM j5_playbook_observations WHERE run_id=${id}`,
        [{ count: 2 }],
      );
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("persists successor scheduling, gate edits, approval, and stale gate rejection", () =>
  Effect.gen(function* () {
    yield* runPlaybookMigrations();
    const store = yield* makeStore;
    const editableDefinition: Definition = {
      ...definition,
      editGate: (run, content) => ({ artifact: run.artifacts.at(-1)!, content }),
    };
    const started = yield* store.command(
      {
        commandId: "editable-start",
        runId: initial.id,
        expectedRevision: 0,
        initial,
        event: { type: "enter" },
        now: 0,
      },
      editableDefinition,
    );
    const planned = yield* store.command(
      {
        commandId: "editable-plan",
        runId: initial.id,
        expectedRevision: started.revision,
        event: { type: "result", actionId: started.actions[0]!.id, output: "plan" },
        now: 1,
      },
      editableDefinition,
    );
    assert.equal(planned.phase, "code");
    assert.lengthOf(planned.actions, 2);
    assert.lengthOf(planned.artifacts, 1);
    const waiting = yield* store.command(
      {
        commandId: "editable-check",
        runId: initial.id,
        expectedRevision: planned.revision,
        event: { type: "result", actionId: planned.actions[1]!.id, output: "passed" },
        now: 2,
      },
      editableDefinition,
    );
    const edited = yield* store.command(
      {
        commandId: "editable-gate",
        runId: initial.id,
        expectedRevision: waiting.revision,
        event: {
          type: "edit_gate",
          gateRevision: waiting.gate!.revision,
          artifactHash: waiting.gate!.artifactHash,
          content: "edited",
          actor: "human",
        },
        now: 3,
      },
      editableDefinition,
    );
    assert.lengthOf(edited.artifacts, 3);
    assert.notEqual(edited.gate!.artifactHash, waiting.gate!.artifactHash);
    const stale = yield* Effect.exit(
      store.command(
        {
          commandId: "stale-edit",
          runId: initial.id,
          expectedRevision: waiting.revision,
          event: {
            type: "edit_gate",
            gateRevision: waiting.gate!.revision,
            artifactHash: waiting.gate!.artifactHash,
            content: "stale",
            actor: "human",
          },
          now: 4,
        },
        editableDefinition,
      ),
    );
    assert.isTrue(Exit.isFailure(stale));
    const approval = {
      commandId: "editable-approve",
      runId: initial.id,
      expectedRevision: edited.revision,
      event: {
        type: "decision" as const,
        decision: {
          gateRevision: edited.gate!.revision,
          artifactHash: edited.gate!.artifactHash,
          decision: "approve" as const,
          feedback: "",
          actor: "human",
        },
      },
      now: 5,
    };
    const completed = yield* store.command(approval, editableDefinition);
    assert.equal(completed.status, "completed");
    assert.deepEqual(yield* store.command(approval, editableDefinition), completed);
    assert.deepEqual(yield* store.get(initial.id), completed);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("persists correction and multi-action cancellation", () =>
  Effect.gen(function* () {
    yield* runPlaybookMigrations();
    const store = yield* makeStore;
    const started = yield* store.command(
      {
        commandId: "correction-start",
        runId: reviewInitial.id,
        expectedRevision: 0,
        initial: reviewInitial,
        event: { type: "enter" },
        now: 0,
      },
      reviewDefinition,
    );
    const corrected = yield* store.command(
      {
        commandId: "correction-invalid",
        runId: reviewInitial.id,
        expectedRevision: started.revision,
        event: { type: "result", actionId: started.actions[0]!.id, output: 42 },
        now: 1,
      },
      reviewDefinition,
    );
    assert.lengthOf(corrected.actions, 3);
    assert.equal(corrected.actions[0]!.status, "cancelled");
    assert.equal(corrected.actions.at(-1)!.attempt, 2);
    const cancelling = yield* store.command(
      {
        commandId: "correction-cancel",
        runId: reviewInitial.id,
        expectedRevision: corrected.revision,
        event: { type: "cancel" },
        now: 2,
      },
      reviewDefinition,
    );
    assert.equal(cancelling.status, "cancelling");
    assert.isTrue(cancelling.actions.every((action) => action.status === "cancelled"));
    const cancelled = yield* store.command(
      {
        commandId: "correction-cancelled",
        runId: reviewInitial.id,
        expectedRevision: cancelling.revision,
        event: { type: "cancelled" },
        now: 3,
      },
      undefined,
    );
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(yield* store.get(reviewInitial.id), cancelled);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it("replays deterministic transitions and invalidates approval on requested changes", () => {
  const first = decide(initial, { type: "enter" }, definition, 0);
  assert.deepStrictEqual(first, decide(initial, { type: "enter" }, definition, 0));
  const written = decide(
    first,
    { type: "result", actionId: first.actions[0]!.id, output: "plan" },
    definition,
    1,
  );
  const checked = decide(
    written,
    { type: "result", actionId: written.actions[1]!.id, output: "passed" },
    definition,
    2,
  );
  assert.equal(checked.status, "waiting_approval");
  const decision = {
    gateRevision: checked.gate!.revision,
    artifactHash: checked.gate!.artifactHash,
    decision: "request_changes" as const,
    feedback: "Make smaller",
    actor: "human",
  };
  const revised = decide(checked, { type: "decision", decision }, definition, 3);
  assert.equal(revised.gate, null);
  assert.equal(revised.visits.agent, 2);
  assert.throws(() =>
    decide(
      revised,
      { type: "decision", decision: { ...decision, decision: "approve" } },
      definition,
      4,
    ),
  );
});

it("bounds invalid-output corrections, preserves deadlines, and ignores late results", () => {
  let run = decide(initial, { type: "enter" }, definition, 0);
  const original = run.actions[0]!;
  for (let correction = 0; correction < 3; correction++) {
    run = decide(
      run,
      { type: "result", actionId: run.actions.at(-1)!.id, output: 42 },
      definition,
      correction + 1,
    );
  }
  assert.equal(run.status, "blocked");
  assert.equal(run.failureCategory, "invalid_action_output");
  assert.equal(run.relevantActionId, run.actions.at(-1)!.id);
  assert.lengthOf(run.actions, 3);
  assert.isTrue(run.actions.every((action) => action.deadline === original.deadline));
  const cancelling = decide(run, { type: "cancel" }, definition, 4);
  assert.deepStrictEqual(
    decide(cancelling, { type: "result", actionId: original.id, output: "late" }, definition, 5),
    cancelling,
  );
  assert.equal(decide(cancelling, { type: "cancelled" }, undefined, 6).status, "cancelled");
});

it("blocks changed definitions and expired attempts", () => {
  const run = decide(initial, { type: "enter" }, definition, 0);
  const mismatched = decide(run, { type: "recover" }, undefined, 1);
  assert.equal(mismatched.recovery, "restore_definition");
  assert.equal(mismatched.failureCategory, "definition_mismatch");
  const expired = decide(
    run,
    { type: "result", actionId: run.actions[0]!.id, output: "late" },
    definition,
    1_800_000,
  );
  assert.equal(expired.status, "blocked");
  assert.equal(expired.failureCategory, "action_deadline_expired");
  assert.equal(expired.relevantActionId, run.actions[0]!.id);
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});

it.effect("migrates twice and recovers state, command receipts and fenced claims", () =>
  Effect.gen(function* () {
    yield* runPlaybookMigrations();
    const store = yield* makeStore;
    const start = {
      commandId: "start",
      runId: initial.id,
      expectedRevision: 0,
      event: { type: "enter" as const },
      now: 0,
      initial,
    };
    const run = yield* store.command(start, definition);
    yield* runPlaybookMigrations();
    const restarted = yield* makeStore;
    assert.deepStrictEqual(yield* restarted.command(start, definition), run);
    assert.deepStrictEqual(yield* restarted.get(run.id), run);
    const conflict = yield* Effect.exit(
      restarted.command({ ...start, initial: { ...initial, inputs: "different" } }, definition),
    );
    assert.isTrue(Exit.isFailure(conflict));
    const claim1 = yield* store.claim(run.actions[0]!.id, "worker-1", 0);
    assert.isNotNull(claim1);
    const beforeHeartbeat = yield* store.readVersion(run.id);
    yield* store.renew(claim1!, 1);
    assert.equal(yield* store.readVersion(run.id), beforeHeartbeat);
    yield* store.identity(claim1!, "thread:pb:identity", 2);
    assert.equal(yield* store.readVersion(run.id), beforeHeartbeat + 1);
    assert.isNull(yield* restarted.claim(run.actions[0]!.id, "worker-2", 1));
    const claim2 = yield* restarted.claim(run.actions[0]!.id, "worker-2", 60_001);
    assert.isNotNull(claim2);
    const stale = yield* Effect.exit(
      store.command(
        {
          commandId: "stale",
          runId: run.id,
          expectedRevision: run.revision,
          event: { type: "result", actionId: run.actions[0]!.id, output: "stale" },
          claim: claim1!,
          now: 60_002,
        },
        definition,
      ),
    );
    assert.isTrue(Exit.isFailure(stale));
    const finished = yield* restarted.command(
      {
        commandId: "done",
        runId: run.id,
        expectedRevision: run.revision,
        event: { type: "result", actionId: run.actions[0]!.id, output: "plan" },
        claim: claim2!,
        now: 60_002,
      },
      definition,
    );
    assert.equal(finished.phase, "code");
    assert.equal(finished.actions[0]!.externalIdentity, "thread:pb:identity");
    const duplicate = yield* restarted.command(
      {
        commandId: "duplicate-result",
        runId: run.id,
        expectedRevision: finished.revision,
        event: { type: "result", actionId: run.actions[0]!.id, output: "plan" },
        now: 60_003,
      },
      definition,
    );
    assert.deepStrictEqual(duplicate, finished);
    const revisionConflict = yield* Effect.exit(
      restarted.command(
        {
          commandId: "wrong-revision",
          runId: run.id,
          expectedRevision: finished.revision + 1,
          event: { type: "cancel" },
          now: 60_004,
        },
        definition,
      ),
    );
    assert.isTrue(Exit.isFailure(revisionConflict));
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER fail_playbook_receipt BEFORE INSERT ON j5_playbook_receipts
      WHEN NEW.command_id='receipt-failure'
      BEGIN SELECT RAISE(ABORT, 'induced receipt failure'); END`;
    const receiptFailure = yield* Effect.exit(
      restarted.command(
        {
          commandId: "receipt-failure",
          runId: run.id,
          expectedRevision: finished.revision,
          event: { type: "cancel" },
          now: 60_005,
        },
        definition,
      ),
    );
    assert.isTrue(Exit.isFailure(receiptFailure));
    assert.deepStrictEqual(yield* restarted.get(run.id), finished);
    yield* sql`DROP TRIGGER fail_playbook_receipt`;
    const detail = yield* restarted.detail(run.id);
    assert.equal(detail.actions[0]!.externalIdentity, "thread:pb:identity");
    assert.notProperty(detail.actions[0]!, "input");
    assert.notProperty(detail.artifacts[0]!, "content");
    // A replay is the original response, including its then-pending action state.
    assert.deepStrictEqual(yield* restarted.command(start, definition), run);
    const values = yield* sql<{ count: number }>`SELECT count(*) AS count FROM j5_playbook_values`;
    const activeArtifacts = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM j5_playbook_artifacts`;
    const observations = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM j5_playbook_observations WHERE run_id=${run.id}`;
    const history = yield* sql<{ count: number }>`SELECT count(*) AS count
      FROM j5_playbook_history WHERE run_id=${run.id}`;
    assert.isAbove(values[0]!.count, 0);
    assert.equal(activeArtifacts[0]!.count, finished.artifacts.length);
    // Replay, no-op, revision, stale-claim, command-id, and receipt failures add no evidence.
    assert.equal(observations[0]!.count, 2);
    assert.equal(history[0]!.count, 2);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("services all 101 eligible playbooks in one complete sweep", () =>
  Effect.gen(function* () {
    yield* runPlaybookMigrations();
    const store = yield* makeStore;
    yield* Effect.forEach(
      Array.from({ length: 101 }, (_, index) => index),
      (index) => {
        const run = { ...initial, id: `sweep-${index}` };
        return store.command(
          {
            commandId: `start-${index}`,
            runId: run.id,
            expectedRevision: 0,
            initial: run,
            event: { type: "enter" },
            now: 0,
          },
          definition,
        );
      },
      { concurrency: 4 },
    );
    const adapter: Adapter = {
      recovery: "reconcile",
      reconcile: () => Effect.succeed({ status: "completed", output: "passed" }),
      interrupt: () => Effect.void,
    };
    yield* makeWorker(store, [definition], { scripted: adapter }, "sweep-worker").drain(1);
    const states = yield* Effect.forEach(
      Array.from({ length: 101 }, (_, index) => store.get(`sweep-${index}`)),
      (read) => read,
      { concurrency: 4 },
    );
    assert.isTrue(states.every((run) => run.status === "waiting_approval"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("isolates an adapter failure from other playbooks in the same pass", () =>
  Effect.gen(function* () {
    yield* runPlaybookMigrations();
    const store = yield* makeStore;
    for (const id of ["failing", "healthy"]) {
      const run = { ...initial, id };
      yield* store.command(
        {
          commandId: `start-${id}`,
          runId: id,
          expectedRevision: 0,
          initial: run,
          event: { type: "enter" },
          now: 0,
        },
        definition,
      );
    }
    const adapter: Adapter = {
      recovery: "reconcile",
      reconcile: (action) =>
        action.runId === "failing"
          ? Effect.fail(new PlaybookError({ code: "invalid", detail: "fixture failure" }))
          : Effect.succeed({ status: "completed", output: "passed" }),
      interrupt: () => Effect.void,
    };
    yield* makeWorker(store, [definition], { scripted: adapter }, "failure-worker").drain(1);
    assert.equal((yield* store.get("failing")).status, "blocked");
    assert.equal((yield* store.get("healthy")).status, "waiting_approval");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "reconciles a launch after a crash before identity persistence and completes the human gate",
  () =>
    Effect.gen(function* () {
      yield* runPlaybookMigrations();
      const store = yield* makeStore;
      const run = yield* store.command(
        {
          commandId: "start",
          runId: initial.id,
          initial,
          expectedRevision: 0,
          event: { type: "enter" },
          now: 0,
        },
        definition,
      );
      // The external launch receipt exists, but the crashed worker never wrote its result.
      const launches = new Map([[run.actions[0]!.id, "exact-thread:exact-run"]]);
      const adapter: Adapter = {
        recovery: "reconcile",
        reconcile: (action, _run, record) =>
          Effect.gen(function* () {
            if (!launches.has(action.id)) launches.set(action.id, `external:${action.id}`);
            yield* record(launches.get(action.id)!);
            return { status: "completed", output: "passed" };
          }),
        interrupt: () => Effect.void,
      };
      const worker = makeWorker(store, [definition], { scripted: adapter }, "restarted-worker");
      yield* worker.drain(1);
      const waiting = yield* store.get(run.id);
      assert.equal(waiting.status, "waiting_approval");
      assert.equal(launches.size, 2);
      const approve = {
        commandId: "approve",
        runId: run.id,
        expectedRevision: waiting.revision,
        now: 2,
        event: {
          type: "decision" as const,
          decision: {
            gateRevision: waiting.gate!.revision,
            artifactHash: waiting.gate!.artifactHash,
            actor: "human",
            decision: "approve" as const,
            feedback: "",
          },
        },
      };
      assert.equal((yield* store.command(approve, definition)).status, "completed");
      assert.equal((yield* store.command(approve, definition)).status, "completed");
      yield* worker.drain(3);
      assert.equal(launches.size, 2);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

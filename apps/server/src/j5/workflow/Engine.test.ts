// @effect-diagnostics nodeBuiltinImport:off - disk reopen fixture.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { Run } from "@j5/workflow-contracts";
import { decide } from "./decider.ts";
import { hash, type Definition } from "./Definition.ts";
import { runWorkflowMigrations } from "./Migrations.ts";
import { makeStore, WorkflowError } from "./Store.ts";
import { makeWorker, type Adapter } from "./Worker.ts";
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
      compatibleDefinitionUpgrade: false,
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
        compatibleDefinitionUpgrade: false,
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
      compatibleDefinitionUpgrade: false,
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

it("records a compatible definition upgrade and keeps unknown mismatches protected", () => {
  const entered = decide(reviewInitial, { type: "enter" }, reviewDefinition, 0);
  const blocked = decide(
    entered,
    {
      type: "block",
      actionId: entered.actions[0]!.id,
      cause: "deadline elapsed",
      recovery: null,
      failureCategory: "action_deadline_expired",
    },
    reviewDefinition,
    1,
  );
  const oldHash = "known-old-hash";
  const oldRun = { ...blocked, definitionHash: oldHash };
  const upgraded = decide(
    oldRun,
    {
      type: "restart_phase",
      targetDefinitionHash: reviewDefinition.hash,
      actor: "reviewer",
      compatibleDefinitionUpgrade: true,
    },
    reviewDefinition,
    2,
  );
  assert.equal(upgraded.definitionHash, reviewDefinition.hash);
  assert.deepInclude(upgraded.definitionUpgrades?.[0], {
    actor: "reviewer",
    fromHash: oldHash,
    toHash: reviewDefinition.hash,
  });
  const protectedRun = decide(
    oldRun,
    {
      type: "restart_phase",
      targetDefinitionHash: reviewDefinition.hash,
      actor: "reviewer",
      compatibleDefinitionUpgrade: false,
    },
    reviewDefinition,
    2,
  );
  assert.equal(protectedRun.failureCategory, "definition_mismatch");
  assert.equal(protectedRun.definitionHash, oldHash);
});

it.effect("persists restart cleanup, deduplicates requests, and resumes after cleanup retry", () =>
  Effect.gen(function* () {
    yield* runWorkflowMigrations();
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
        compatibleDefinitionUpgrade: false,
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
            return yield* new WorkflowError({ code: "invalid", detail: "interrupt unavailable" });
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
        yield* runWorkflowMigrations();
        return yield* (yield* makeStore).command(command, definition);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
    const recovered = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* runWorkflowMigrations();
        return yield* (yield* makeStore).command(command, definition);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
    assert.deepStrictEqual(recovered, started);
  }),
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
    yield* runWorkflowMigrations();
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
    yield* runWorkflowMigrations();
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
    yield* store.identity(claim1!, "thread:wf:identity", 2);
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
    const detail = yield* restarted.detail(run.id);
    assert.notProperty(detail.actions[0]!, "input");
    assert.notProperty(detail.artifacts[0]!, "content");
    // A replay is the original response, including its then-pending action state.
    assert.deepStrictEqual(yield* restarted.command(start, definition), run);
    const sql = yield* SqlClient.SqlClient;
    const values = yield* sql<{ count: number }>`SELECT count(*) AS count FROM j5_workflow_values`;
    const activeArtifacts = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM j5_workflow_artifacts`;
    const legacyRuns = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM j5_workflow_runs_legacy_v1`;
    assert.isAbove(values[0]!.count, 0);
    assert.equal(activeArtifacts[0]!.count, finished.artifacts.length);
    assert.equal(legacyRuns[0]!.count, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("services all 101 eligible workflows in one complete sweep", () =>
  Effect.gen(function* () {
    yield* runWorkflowMigrations();
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

it.effect("isolates an adapter failure from other workflows in the same pass", () =>
  Effect.gen(function* () {
    yield* runWorkflowMigrations();
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
          ? Effect.fail(new WorkflowError({ code: "invalid", detail: "fixture failure" }))
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
      yield* runWorkflowMigrations();
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

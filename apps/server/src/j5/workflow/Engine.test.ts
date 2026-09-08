// @effect-diagnostics nodeBuiltinImport:off - disk reopen fixture.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { Run } from "@j5/workflow-contracts";
import { decide } from "./decider.ts";
import { hash, type Definition } from "./Definition.ts";
import { runWorkflowMigrations } from "./Migrations.ts";
import { makeStore } from "./Store.ts";
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

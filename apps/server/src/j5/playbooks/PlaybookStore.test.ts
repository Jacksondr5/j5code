import { makeCheckpointNotifications, unnotifiedCheckpoints } from "./CheckpointNotifications.ts";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Ref from "effect/Ref";
import { makeCheckpointRpcHandlers } from "./checkpointRpc.ts";
import { PlaybookStore } from "./PlaybookStore.ts";
import { PersonAccess } from "../sharing/PersonAccess.ts";
import { SharedThreads } from "../sharing/SharedThreads.ts";
import { ParticipantId } from "../a2a/contracts.ts";
import { AuthSessionId } from "@t3tools/contracts";
import { seedPersonas, seedPlaybookOwners } from "./testFixtures.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, ThreadId } from "@t3tools/contracts";
import {
  J5_PLAYBOOK_WS_METHODS,
  PLAYBOOK_MAX_BYTES,
  PLAYBOOK_MAX_STEPS,
  PLAYBOOK_RUNS_PAGE_SIZE,
  type PlaybookDefinition,
  type PlaybookProgress,
} from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { parse, stringify } from "yaml";

import { ServerConfig } from "../../config.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { makePlaybookStore, type PlaybookMutation } from "./PlaybookStore.ts";
import { makePlaybookRpcHandlers, PLAYBOOK_RPC_SCOPES } from "./playbookRpc.ts";

const owner = ThreadId.make("thread:playbook:owner");
const otherOwner = ThreadId.make("thread:playbook:other");
const MemoryLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
);
const definition = (ids = ["research", "implement", "review"]): PlaybookDefinition => ({
  title: "Test playbook",
  description: "Verify that an agent receives live ordered prompts.",
  steps: ids.map((id) => ({ id, title: `Step ${id}`, prompt: `Follow ${id}.` })),
});

const makeWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-test-" });
  const directory = path.join(workspaceRoot, ".j5", "playbooks");
  yield* fs.makeDirectory(directory, { recursive: true });
  const filename = (name: string) => path.join(directory, `${name}.yaml`);
  const write = (name: string, value = definition()) =>
    fs.writeFileString(filename(name), stringify(value));
  yield* write("demo");
  return { fs, path, workspaceRoot, filename, write };
});

const initializeStore = Effect.gen(function* () {
  yield* runJ5A2AMigrations();
  yield* seedPlaybookOwners([
    owner,
    otherOwner,
    "healthy-owner",
    ...Array.from({ length: PLAYBOOK_RUNS_PAGE_SIZE + 1 }, (_, index) => `owner-${index}`),
  ]);
  return yield* makePlaybookStore;
});

const makeFixture = Effect.gen(function* () {
  const workspace = yield* makeWorkspace;
  const store = yield* initializeStore;
  return { ...workspace, store };
});

it.effect("derives owner ask flags without recipient filtering or request contents", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const sql = yield* SqlClient.SqlClient;
    const run = yield* store.start(owner, workspaceRoot, "demo", "progress-start");
    yield* sql`UPDATE j5_playbook_run SET holder_thread_id = ${otherOwner} WHERE run_id = ${run.runId}`;
    assert.equal((yield* store.listForThread(owner)).runs[0]?.holderName, "Owner");
    yield* sql`UPDATE j5_playbook_run SET holder_thread_id = ${owner} WHERE run_id = ${run.runId}`;
    assert.isNull((yield* store.listForThread(owner)).runs[0]?.holderName);
    const at = "2026-11-01T00:00:00Z";
    yield* sql`INSERT INTO j5_a2a_project_ledger (project_id, created_at) VALUES ('progress', ${at})`;
    for (const [id, thread, person] of [
      ["owner-ask", owner, "human:other-person"],
      ["other-ask", otherOwner, "human:viewer"],
    ]) {
      yield* sql`INSERT INTO j5_a2a_membership (project_id, participant_id, participant_kind, thread_id, joined_seq, updated_seq, payload)
        VALUES ('progress', ${id}, 'agent', ${thread}, 1, 1, '{}')`;
      yield* sql`INSERT INTO j5_a2a_exchange (project_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, created_at, updated_at)
        VALUES ('progress', ${id}, ${id}, ${person}, 'open', 'private intent', 1, ${at}, ${at})`;
      yield* sql`INSERT INTO j5_a2a_human_inbox (person_id, project_id, exchange_id, sender_id, intent, urgency, latest_message_id, latest_message, opened_seq, opened_at, status)
        VALUES (${person}, 'progress', ${id}, ${id}, 'private intent', 'soon', ${id}, 'private body', 1, ${at}, 'open')`;
    }
    const progress = () => store.listForThread(owner).pipe(Effect.map(({ runs }) => runs[0]!));
    assert.isTrue((yield* progress()).blocked);
    yield* sql`INSERT INTO j5_playbook_checkpoint (request_id, run_id, owner_thread_id, step_id, step_title, summary, status, created_at)
      VALUES ('unassociated', ${run.runId}, ${owner}, 'research', 'Research', 'private summary', 'pending', ${at})`;
    assert.isFalse((yield* progress()).waitingForApproval, "only the current checkpoint counts");
    yield* sql`UPDATE j5_playbook_run SET checkpoint_request_id = 'unassociated' WHERE run_id = ${run.runId}`;
    assert.isTrue((yield* progress()).waitingForApproval);
    assert.isTrue((yield* progress()).blocked, "waiting and blocked can coexist");
    yield* sql`UPDATE j5_playbook_checkpoint SET status = 'approved' WHERE request_id = 'unassociated'`;
    assert.isFalse((yield* progress()).waitingForApproval);
    assert.notInclude(JSON.stringify(yield* progress()), "private");
    for (const status of ["answered", "dropped"]) {
      yield* sql`UPDATE j5_a2a_human_inbox SET status = ${status}, terminal_seq = 2, terminal_at = ${at} WHERE exchange_id = 'owner-ask'`;
      assert.isFalse((yield* progress()).blocked, "another thread's open ask does not count");
      yield* sql`UPDATE j5_a2a_human_inbox SET status = 'open', terminal_seq = NULL, terminal_at = NULL WHERE exchange_id = 'owner-ask'`;
      assert.isTrue((yield* progress()).blocked);
    }
    yield* store.mutate(owner, {
      runId: run.runId,
      operation: "cancel",
      client_request_id: "progress-cancel",
    });
    assert.isFalse((yield* progress()).blocked, "terminal runs do not claim to be blocked");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "publishes committed playbook changes during a turn and ignores failures and retries",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot } = yield* makeFixture;
      const snapshots = yield* Queue.unbounded<{
        revision: number;
        runs: ReadonlyArray<PlaybookProgress>;
      }>();
      const handlers = yield* makePlaybookRpcHandlers({
        store,
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.mock(ProjectService)({}), Layer.mock(ThreadManagementService)({})),
        ),
      );
      assert.equal(
        PLAYBOOK_RPC_SCOPES[J5_PLAYBOOK_WS_METHODS.subscribeChanges],
        AuthOrchestrationReadScope,
      );
      yield* handlers[J5_PLAYBOOK_WS_METHODS.subscribeChanges]().pipe(
        Stream.runForEach((revision) =>
          Effect.gen(function* () {
            const { runs } = yield* store.listForThread(owner);
            yield* Queue.offer(snapshots, { revision, runs });
          }),
        ),
        Effect.forkScoped,
      );
      assert.deepStrictEqual(yield* Queue.take(snapshots), { revision: 0, runs: [] });
      const run = yield* store.start(owner, workspaceRoot, "demo", "start");
      const started = yield* Queue.take(snapshots);
      assert.equal(started.revision, 1);
      assert.equal(started.runs[0]?.runId, run.runId);
      assert.equal(started.runs[0]?.status, "active");
      yield* store.start(owner, workspaceRoot, "demo", "start");
      yield* Effect.flip(store.start(owner, workspaceRoot, "demo", "duplicate"));
      yield* Effect.flip(
        store.mutate(otherOwner, {
          operation: "cancel",
          runId: run.runId,
          client_request_id: "foreign",
        }),
      );
      assert.deepStrictEqual(yield* Stream.runHead(store.changes), Option.some(1));

      const moves = [
        { operation: "next", expectedStepId: "research", step: "implement", status: "active" },
        { operation: "back", expectedStepId: "implement", step: "research", status: "active" },
        {
          operation: "next",
          expectedStepId: "research",
          step: "implement",
          status: "active",
        },
        {
          operation: "complete",
          expectedStepId: "implement",
          step: "implement",
          status: "completed",
        },
      ] as const;
      for (const [index, { step, status, ...movement }] of moves.entries()) {
        const input = { ...movement, runId: run.runId, client_request_id: `move-${index}` };
        yield* store.mutate(owner, input);
        const changed = yield* Queue.take(snapshots);
        assert.equal(changed.revision, index + 2);
        assert.equal(changed.runs[0]?.currentStepId, step);
        assert.equal(changed.runs[0]?.status, status);
        yield* store.mutate(owner, input);
        assert.deepStrictEqual(yield* Stream.runHead(store.changes), Option.some(index + 2));
      }
      const second = yield* store.start(owner, workspaceRoot, "demo", "second");
      assert.equal((yield* Queue.take(snapshots)).revision, 6);
      yield* store.mutate(owner, {
        operation: "cancel",
        runId: second.runId,
        client_request_id: "cancel",
      });
      const cancelled = yield* Queue.take(snapshots);
      assert.equal(cancelled.revision, 7);
      assert.equal(cancelled.runs[0]?.status, "cancelled");
      // A new subscriber receives the latest revision even if it missed the mutation.
      assert.deepStrictEqual(yield* Stream.runHead(store.changes), Option.some(7));
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "lists owners together, filters active runs, and reads saved definitions without filesystem access",
  () =>
    Effect.gen(function* () {
      const { workspaceRoot, fs, write, filename } = yield* makeFixture;
      let reads = 0;
      const store = yield* makePlaybookStore.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, encoding) => {
            reads += 1;
            return fs.readFileString(file, encoding);
          },
        }),
      );
      const first = yield* store.start(owner, workspaceRoot, "demo", "first");
      const second = yield* store.start(otherOwner, workspaceRoot, "demo", "second");
      yield* store.mutate(otherOwner, {
        operation: "complete",
        runId: second.runId,
        expectedStepId: "research",
        client_request_id: "finish",
      });
      reads = 0;
      const all = yield* store.listAll({});
      assert.equal(reads, 0);
      assert.equal(all.total, 2);
      assert.deepStrictEqual(
        all.runs.map((run) => run.runId),
        [first.runId, second.runId],
      );
      assert.deepStrictEqual(
        all.runs.map((run) => run.ownerThreadId),
        [owner, otherOwner],
      );
      assert.isFalse(all.runs.some((run) => "currentStep" in run || "replayed" in run));
      assert.isFalse(all.runs.some((run) => run.steps.some((step) => "prompt" in step)));
      const active = yield* store.listAll({ status: "active" });
      assert.equal(active.total, 1);
      assert.deepStrictEqual(
        active.runs.map((run) => run.runId),
        [first.runId],
      );
      yield* write("demo", { ...definition(), title: "Edited live" });
      assert.isTrue((yield* store.listAll({})).runs.every((run) => run.title === "Test playbook"));
      yield* write("healthy");
      yield* store.start(ThreadId.make("healthy-owner"), workspaceRoot, "healthy", "healthy");
      yield* fs.writeFileString(filename("demo"), "title: [invalid");
      reads = 0;
      const broken = yield* store.listAll({});
      assert.equal(reads, 0);
      assert.equal(broken.runs.length, 3);
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("reads no files for twenty thread runs", () =>
  Effect.gen(function* () {
    const { workspaceRoot, fs, write, filename } = yield* makeFixture;
    let reads = 0;
    const store = yield* makePlaybookStore.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (file, encoding) => {
          reads += 1;
          return fs.readFileString(file, encoding);
        },
      }),
    );
    for (let index = 0; index < 20; index++) {
      const run = yield* store.start(owner, workspaceRoot, "demo", `start-${index}`);
      yield* store.mutate(owner, {
        operation: "complete",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: `complete-${index}`,
      });
    }
    reads = 0;
    const first = yield* store.listForThread(owner);
    assert.equal(first.runs.length, 20);
    assert.equal(reads, 0);
    assert.isFalse(first.runs.some((run) => "currentStep" in run));
    yield* write("demo", { ...definition(), title: "Changed title" });
    const second = yield* store.listForThread(owner);
    assert.equal(reads, 0);
    assert.isTrue(second.runs.every((run) => run.title === "Test playbook"));
    yield* fs.writeFileString(filename("demo"), "title: [invalid");
    const broken = yield* store.listForThread(owner);
    assert.equal(broken.runs.length, 20);
    assert.equal(reads, 0);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("pages beyond 100 runs without losing older active owners", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const runs = yield* Effect.forEach(
      Array.from({ length: PLAYBOOK_RUNS_PAGE_SIZE + 1 }, (_, index) => index),
      (index) =>
        store.start(ThreadId.make(`owner-${index}`), workspaceRoot, "demo", `start-${index}`),
    );
    const first = yield* store.listAll({ status: "active" });
    const second = yield* store.listAll({ status: "active", offset: PLAYBOOK_RUNS_PAGE_SIZE });
    assert.equal(first.total, runs.length);
    assert.equal(second.total, runs.length);
    assert.equal(first.runs.length, PLAYBOOK_RUNS_PAGE_SIZE);
    assert.equal(second.runs.length, 1);
    assert.equal(
      new Set([...first.runs, ...second.runs].map((run) => run.runId)).size,
      runs.length,
    );
    assert.deepStrictEqual((yield* store.listAll({ offset: runs.length })).runs, []);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("replays a pre-upgrade crew receipt only for the original start", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const sql = yield* SqlClient.SqlClient;
    const first = yield* store.start(owner, workspaceRoot, "demo", "legacy");
    const receipt = JSON.stringify(["start", first.definitionPath, "old-crew"]);
    yield* sql`UPDATE j5_playbook_request SET request_json = ${receipt} WHERE run_id = ${first.runId}`;
    const retry = yield* store.start(owner, workspaceRoot, "demo.yaml", "legacy");
    assert.isTrue(retry.replayed);
    assert.equal(retry.runId, first.runId);
    assert.equal(
      (yield* Effect.flip(store.start(owner, workspaceRoot, "demo", "legacy", "peer"))).code,
      "request_conflict",
    );
    assert.equal(
      (yield* Effect.flip(store.start(owner, workspaceRoot, "other", "legacy"))).code,
      "request_conflict",
    );
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("retains sequential runs and permits a new run after completion or cancellation", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const first = yield* store.start(owner, workspaceRoot, "demo", "start-a");
    assert.equal(first.currentStep?.prompt, "Follow research.");
    assert.equal(first.position, 1);
    assert.equal(first.total, 3);
    assert.equal(first.ownerThreadId, owner);

    const replay = yield* store.start(owner, workspaceRoot, "demo.yaml", "start-a");
    assert.equal(replay.runId, first.runId);
    assert.isTrue(replay.replayed);
    assert.equal(
      (yield* Effect.flip(store.start(owner, workspaceRoot, "demo", "start-overlap"))).code,
      "already_active",
    );

    const completed = yield* store.mutate(owner, {
      operation: "complete",
      runId: first.runId,
      expectedStepId: "research",
      client_request_id: "complete-a",
    });
    assert.equal(completed.status, "completed");
    const second = yield* store.start(owner, workspaceRoot, "demo", "start-b");
    assert.notEqual(second.runId, first.runId);
    assert.equal((yield* store.current(owner)).runId, second.runId);
    const cancelled = yield* store.mutate(owner, {
      operation: "cancel",
      runId: second.runId,
      client_request_id: "cancel-b",
    });
    assert.equal(cancelled.status, "cancelled");
    const third = yield* store.start(owner, workspaceRoot, "demo", "start-c");
    assert.notEqual(third.runId, second.runId);
    assert.deepStrictEqual(
      (yield* store.listForThread(owner)).runs.map(({ runId, status }) => ({ runId, status })),
      [
        { runId: third.runId, status: "active" },
        { runId: second.runId, status: "cancelled" },
        { runId: first.runId, status: "completed" },
      ],
    );
    assert.equal((yield* store.current(owner, first.runId)).status, "completed");
    assert.equal(
      (yield* Effect.flip(
        store.mutate(owner, {
          operation: "next",
          runId: first.runId,
          expectedStepId: "research",
          client_request_id: "next-terminal",
        }),
      )).code,
      "run_terminal",
    );
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("reports each run's start and its end once, with how far it got", () =>
  Effect.gen(function* () {
    const recorded: Array<Readonly<Record<string, unknown>>> = [];
    yield* Effect.gen(function* () {
      const { store, workspaceRoot } = yield* makeFixture;
      const finished = yield* store.start(owner, workspaceRoot, "demo", "start-a");
      // A retried start is the same run.
      yield* store.start(owner, workspaceRoot, "demo", "start-a");
      yield* store.mutate(owner, {
        operation: "next",
        runId: finished.runId,
        expectedStepId: "research",
        client_request_id: "next-a",
      });
      const complete = {
        operation: "complete",
        runId: finished.runId,
        expectedStepId: "implement",
        client_request_id: "complete-a",
      } as const;
      yield* store.mutate(owner, complete);
      yield* store.mutate(owner, complete);
      const abandoned = yield* store.start(owner, workspaceRoot, "demo", "start-b");
      yield* store.mutate(owner, {
        operation: "cancel",
        runId: abandoned.runId,
        client_request_id: "cancel-b",
      });
    }).pipe(
      Effect.provide(
        Layer.succeed(
          AnalyticsService,
          AnalyticsService.of({
            record: (event, properties = {}) =>
              Effect.sync(() => void recorded.push({ event, ...properties })),
            flush: Effect.void,
            recordOwners: () => Effect.void,
          }),
        ),
      ),
    );
    const started = {
      event: "j5.playbook.run.started",
      stepCount: 3,
      stepsWithPersona: 0,
      crewBound: false,
    };
    const ended = { event: "j5.playbook.run.finished", cause: "agent", crewBound: false };
    assert.deepStrictEqual(recorded, [
      started,
      // Completed from the second of three steps: moving between steps records nothing.
      { ...ended, outcome: "completed", stepCount: 3, position: 2, durationMs: 0 },
      started,
      { ...ended, outcome: "cancelled", stepCount: 3, position: 1, durationMs: 0 },
    ]);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("keeps prompts, purpose and step order from start despite library edits", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write } = yield* makeFixture;
    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "research",
      client_request_id: "next",
    });
    const edited = definition(["review", "implement", "research"]);
    yield* write("demo", {
      ...edited,
      description: "Updated purpose.",
      steps: edited.steps.map((step) =>
        step.id === "implement"
          ? { ...step, prompt: "Use the revised implementation instructions." }
          : step,
      ),
    });
    const current = yield* store.current(owner, run.runId);
    assert.equal(current.currentStepId, "implement");
    assert.equal(current.position, 2);
    assert.equal(current.description, definition().description);
    assert.equal(current.currentStep?.prompt, "Follow implement.");

    const next = yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "next-edited",
    });
    assert.equal(next.currentStepId, "review");
    assert.equal(next.position, 3);
    const back = yield* store.mutate(owner, {
      operation: "back",
      runId: run.runId,
      expectedStepId: "review",
      client_request_id: "back-edited",
    });
    assert.equal(back.currentStep?.prompt, "Follow implement.");
    const board = (yield* store.listForThread(owner)).runs[0]!;
    assert.deepStrictEqual(
      board.steps.map(({ id }) => id),
      ["research", "implement", "review"],
    );
    assert.notProperty(board, "currentStep");
    assert.isFalse(board.steps.some((step) => "prompt" in step));
    assert.notProperty(board, "definition");
    assert.notProperty(current, "definition");
    yield* store.mutate(owner, {
      operation: "cancel",
      runId: run.runId,
      client_request_id: "cancel",
    });
    const future = yield* store.start(owner, workspaceRoot, "demo", "future");
    assert.equal(future.description, "Updated purpose.");
    assert.equal(future.currentStepId, "review");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("keeps the current step after the library removes it, including start retries", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write, fs, filename } = yield* makeFixture;
    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    yield* write("demo", definition(["implement", "review"]));
    assert.equal((yield* store.current(owner)).currentStep?.prompt, "Follow research.");
    yield* fs.remove(filename("demo"));
    const replayed = yield* store.start(owner, workspaceRoot, "demo", "start");
    assert.equal(replayed.runId, run.runId);
    assert.isTrue(replayed.replayed);
    assert.equal(replayed.currentStep?.prompt, "Follow research.");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("preserves progress for invalid or missing YAML and always permits cancellation", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, fs, filename, write } = yield* makeFixture;
    for (const broken of ["invalid", "missing"] as const) {
      yield* write("demo");
      const run = yield* store.start(owner, workspaceRoot, "demo", `start-${broken}`);
      if (broken === "invalid") yield* fs.writeFileString(filename("demo"), "title: [broken");
      else yield* fs.remove(filename("demo"));
      assert.equal(
        (yield* store.current(owner, run.runId)).currentStep?.prompt,
        "Follow research.",
      );
      const moved = yield* store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: `next-${broken}`,
      });
      assert.equal(moved.currentStepId, "implement");
      const board = (yield* store.listForThread(owner)).runs[0]!;
      assert.equal(board.currentStepId, "implement");
      assert.equal(board.status, "active");

      const cancelled = yield* store.mutate(owner, {
        operation: "cancel",
        runId: run.runId,
        client_request_id: `cancel-${broken}`,
      });
      assert.equal(cancelled.status, "cancelled");

      assert.equal((yield* store.current(owner, run.runId)).status, "cancelled");
    }
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "discovers malformed definitions without hiding valid files or creating invalid runs",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, fs, filename, path } = yield* makeFixture;
      const invalidFiles = {
        duplicate: stringify(definition(["research", "research"])),
        empty: stringify(definition([])),
        malformed: "title: [broken",
        "missing-prompt":
          "title: Missing prompt\ndescription: Invalid\nsteps:\n  - id: first\n    title: First\n",
      };
      for (const [name, content] of Object.entries(invalidFiles)) {
        yield* fs.writeFileString(filename(name), content);
      }
      const discovered = yield* store.discover(workspaceRoot);
      assert.deepStrictEqual(
        discovered.playbooks.map(({ name }) => name),
        ["demo", "duplicate", "empty", "malformed", "missing-prompt"],
      );
      assert.equal(discovered.playbooks[0]?.stepCount, 3);
      assert.isNull(discovered.playbooks[0]?.issue);
      for (const name of Object.keys(invalidFiles)) {
        assert.equal(
          discovered.playbooks.find((entry) => entry.name === name)?.issue?.code,
          "invalid_definition",
        );
        assert.equal(
          (yield* Effect.flip(store.start(owner, workspaceRoot, name, name))).code,
          "invalid_definition",
        );
      }
      assert.deepStrictEqual((yield* store.listForThread(owner)).runs, []);
      assert.deepStrictEqual(
        (yield* store.discover(path.join(workspaceRoot, "empty-workspace"))).playbooks,
        [],
      );
      assert.equal(
        (yield* Effect.flip(store.start(owner, workspaceRoot, "../demo", "outside"))).code,
        "invalid_name",
      );
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "lists a misnamed file with a rename hint, refuses to start it, and still deletes it",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, fs, filename, write } = yield* makeFixture;
      yield* write("Release Plan");
      const entry = (yield* store.discover(workspaceRoot)).playbooks.find(
        ({ name }) => name === "Release Plan",
      );
      assert.equal(entry?.title, "Test playbook");
      assert.equal(entry?.issue?.code, "invalid_name");
      assert.include(entry?.issue?.message, "release-plan.yaml");
      assert.equal(
        (yield* Effect.flip(store.start(owner, workspaceRoot, "Release Plan", "misnamed"))).code,
        "invalid_name",
      );
      yield* store.removeDefinition(workspaceRoot, "Release Plan");
      assert.isFalse(yield* fs.exists(filename("Release Plan")));
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("rejects first and last step movement and stale back or completion requests", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    const firstBoundary = yield* Effect.flip(
      store.mutate(owner, {
        operation: "back",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: "before-first",
      }),
    );
    assert.equal(firstBoundary.code, "step_boundary");
    assert.equal((yield* store.current(owner, run.runId)).currentStepId, "research");
    yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "research",
      client_request_id: "next-1",
    });
    for (const operation of ["next", "back", "complete"] as const) {
      assert.equal(
        (yield* Effect.flip(
          store.mutate(owner, {
            operation,
            runId: run.runId,
            expectedStepId: "research",
            client_request_id: `stale-${operation}`,
          }),
        )).code,
        "step_conflict",
      );
    }
    yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "next-2",
    });
    const lastBoundary = yield* Effect.flip(
      store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "review",
        client_request_id: "after-last",
      }),
    );
    assert.equal(lastBoundary.code, "step_boundary");
    assert.include(lastBoundary.message, "j5_playbook_complete");
    assert.equal((yield* store.current(owner, run.runId)).currentStepId, "review");
    assert.equal(
      (yield* store.mutate(owner, {
        operation: "complete",
        runId: run.runId,
        expectedStepId: "review",
        client_request_id: "complete",
      })).status,
      "completed",
    );
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("serializes concurrent starts and advancement without double-advancing", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const starts = yield* Effect.forEach(
      ["start-1", "start-2"],
      (key) => store.start(owner, workspaceRoot, "demo", key).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    assert.equal(starts.filter(Result.isSuccess).length, 1);
    assert.deepStrictEqual(
      starts.filter(Result.isFailure).map(({ failure }) => failure.code),
      ["already_active"],
    );
    const run = yield* store.current(owner);
    const results = yield* Effect.forEach(
      ["next-1", "next-2"],
      (key) =>
        store
          .mutate(owner, {
            operation: "next",
            runId: run.runId,
            expectedStepId: "research",
            client_request_id: key,
          })
          .pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    assert.equal(results.filter(Result.isSuccess).length, 1);
    assert.deepStrictEqual(
      results.filter(Result.isFailure).map(({ failure }) => failure.code),
      ["step_conflict"],
    );
    assert.equal((yield* store.current(owner)).currentStepId, "implement");
    const retryInput = {
      operation: "next",
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "same-next",
    } as const;
    const retries = yield* Effect.all(
      [store.mutate(owner, retryInput), store.mutate(owner, retryInput)],
      {
        concurrency: "unbounded",
      },
    );
    assert.deepStrictEqual(retries.map(({ replayed }) => replayed).sort(), [false, true]);
    assert.equal((yield* store.current(owner)).currentStepId, "review");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("serializes concurrent back and completion requests", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    for (const operation of ["back", "complete"] as const) {
      const run = yield* store.start(owner, workspaceRoot, "demo", `start-${operation}`);
      yield* store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: `advance-${operation}`,
      });
      const results = yield* Effect.forEach(
        ["one", "two"],
        (key) =>
          store
            .mutate(owner, {
              operation,
              runId: run.runId,
              expectedStepId: "implement",
              client_request_id: `${operation}-${key}`,
            })
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter(Result.isSuccess).length, 1);
      assert.deepStrictEqual(
        results.filter(Result.isFailure).map(({ failure }) => failure.code),
        [operation === "back" ? "step_conflict" : "run_terminal"],
      );
      const current = yield* store.current(owner, run.runId);
      assert.equal(current.currentStepId, operation === "back" ? "research" : "implement");
      assert.equal(current.status, operation === "back" ? "active" : "completed");
      if (operation === "back") {
        yield* store.mutate(owner, {
          operation: "cancel",
          runId: run.runId,
          client_request_id: "cancel-back-run",
        });
      }
    }
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "isolates owners for every operation including another owner's successful request key",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot } = yield* makeFixture;
      const run = yield* store.start(owner, workspaceRoot, "demo", "start");
      yield* store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: "owned-next",
      });
      assert.equal((yield* Effect.flip(store.current(otherOwner, run.runId))).code, "not_owner");
      const mutations: ReadonlyArray<PlaybookMutation> = [
        {
          operation: "next",
          runId: run.runId,
          expectedStepId: "research",
          client_request_id: "owned-next",
        },
        {
          operation: "back",
          runId: run.runId,
          expectedStepId: "implement",
          client_request_id: "foreign-back",
        },
        {
          operation: "complete",
          runId: run.runId,
          expectedStepId: "implement",
          client_request_id: "foreign-complete",
        },
        {
          operation: "next",
          runId: run.runId,
          expectedStepId: "implement",
          client_request_id: "foreign-next",
        },
        { operation: "cancel", runId: run.runId, client_request_id: "foreign-cancel" },
      ];
      for (const input of mutations) {
        assert.equal((yield* Effect.flip(store.mutate(otherOwner, input))).code, "not_owner");
      }
      assert.deepStrictEqual((yield* store.listForThread(otherOwner)).runs, []);
      assert.equal((yield* store.current(owner, run.runId)).currentStepId, "implement");
      assert.equal((yield* store.current(owner, run.runId)).status, "active");
      const separate = yield* store.start(otherOwner, workspaceRoot, "demo", "start");
      assert.notEqual(separate.runId, run.runId);
      assert.equal(separate.ownerThreadId, otherOwner);
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "persists progress and consumed request keys across back navigation and database restart",
  () =>
    Effect.gen(function* () {
      const { workspaceRoot, path, write } = yield* makeWorkspace;
      const databasePath = path.join(workspaceRoot, "state.sqlite");
      const runId = yield* Effect.gen(function* () {
        const store = yield* initializeStore;
        const run = yield* store.start(owner, workspaceRoot, "demo", "start");
        const next = {
          operation: "next",
          runId: run.runId,
          expectedStepId: "research",
          client_request_id: "next",
        } as const;
        yield* store.mutate(owner, next);
        yield* store.mutate(owner, {
          operation: "back",
          runId: run.runId,
          expectedStepId: "implement",
          client_request_id: "back",
        });
        const retried = yield* store.mutate(owner, next);
        assert.isTrue(retried.replayed);
        assert.equal(retried.currentStepId, "research");
        assert.equal((yield* store.current(owner, run.runId)).currentStepId, "research");
        assert.equal(
          (yield* Effect.flip(
            store.mutate(owner, {
              operation: "complete",
              runId: run.runId,
              expectedStepId: "research",
              client_request_id: "next",
            }),
          )).code,
          "request_conflict",
        );
        yield* store.mutate(owner, {
          operation: "revise",
          runId: run.runId,
          expectedStepId: "research",
          client_request_id: "revise-before-restart",
          basis: "approved",
          steps: definition().steps.map((step) => ({ ...step, prompt: `Revised ${step.id}.` })),
        });
        return run.runId;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

      yield* write("demo", {
        ...definition(),
        steps: definition().steps.map((step) => ({ ...step, prompt: `After restart: ${step.id}` })),
      });
      yield* Effect.gen(function* () {
        const store = yield* initializeStore;
        const current = yield* store.current(owner);
        assert.equal(current.runId, runId);
        assert.equal(current.currentStepId, "research");
        assert.equal(current.currentStep?.prompt, "Revised research.");
        assert.equal(current.revisionCount, 1);
        assert.equal(current.latestRevision?.basis, "approved");
        const retry = yield* store.mutate(owner, {
          operation: "next",
          runId,
          expectedStepId: "research",
          client_request_id: "next",
        });
        assert.isTrue(retry.replayed);
        assert.equal(retry.currentStepId, "research");
        assert.equal(retry.currentStep?.prompt, "Revised research.");
        assert.equal((yield* store.current(owner)).currentStepId, "research");
        assert.equal((yield* store.listForThread(owner)).runs.length, 1);
        const moved = yield* store.mutate(owner, {
          operation: "next",
          runId,
          expectedStepId: "research",
          client_request_id: "new-next",
        });
        assert.equal(moved.currentStepId, "implement");
        const newStore = yield* makePlaybookStore;
        assert.equal((yield* newStore.current(owner, runId)).currentStepId, "implement");
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("cancels deleted, missing and archived owners before reads or deletion", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write, fs, filename } = yield* makeFixture;
    const sql = yield* SqlClient.SqlClient;
    yield* write("archived");
    const archived = yield* store.start(otherOwner, workspaceRoot, "archived", "archived");
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = '2026-09-23' WHERE thread_id = ${otherOwner}`;
    for (const entry of ["current", "thread", "active", "delete"] as const) {
      for (const missing of [false, true]) {
        yield* seedPlaybookOwners([owner]);
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${owner}`;
        yield* write("demo");
        const run = yield* store.start(owner, workspaceRoot, "demo", `${entry}-${missing}`);
        if (missing)
          yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${owner}`;
        else
          yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-09-23' WHERE thread_id = ${owner}`;
        if (entry === "current")
          assert.equal((yield* store.current(owner, run.runId)).status, "cancelled");
        if (entry === "thread")
          assert.equal((yield* store.listForThread(owner)).runs[0]?.status, "cancelled");
        if (entry === "active")
          assert.deepStrictEqual(
            (yield* store.listAll({ status: "active" })).runs.map((run) => run.runId),
            [],
          );
        yield* store.removeDefinition(workspaceRoot, "demo");
        assert.isFalse(yield* fs.exists(filename("demo")));
        const history = yield* store.current(owner, run.runId);
        assert.equal(history.status, "cancelled");

        yield* write("demo");
        assert.equal(
          (yield* Effect.flip(
            store.start(owner, workspaceRoot, "demo", `deleted-${entry}-${missing}`),
          )).code,
          "thread_not_found",
        );
      }
    }
    assert.equal((yield* store.current(otherOwner, archived.runId)).status, "cancelled");
    assert.equal((yield* store.current(otherOwner, archived.runId)).cancelReason, "owner_archived");
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = NULL WHERE thread_id = ${otherOwner}`;
    assert.equal((yield* store.current(otherOwner, archived.runId)).status, "cancelled");
    assert.deepStrictEqual(yield* store.removeDefinition(workspaceRoot, "archived"), {
      deleted: true,
    });
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "keeps completed and cancelled snapshots available after library edits and deletion",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, write, fs, filename } = yield* makeFixture;
      for (const operation of ["complete", "cancel"] as const) {
        yield* write("demo");
        const run = yield* store.start(owner, workspaceRoot, "demo", `start-${operation}`);
        yield* store.mutate(owner, {
          operation,
          runId: run.runId,
          expectedStepId: "research",
          client_request_id: operation,
        });
        yield* write("demo", { ...definition(["review"]), title: "Edited library title" });
        for (const change of ["edited", "deleted"] as const) {
          if (change === "deleted") yield* fs.remove(filename("demo"));
          const current = yield* store.current(owner, run.runId);
          const threadHistory = (yield* store.listForThread(owner)).runs.find(
            (entry) => entry.runId === run.runId,
          )!;
          const allHistory = (yield* store.listAll({})).runs.find(
            (entry) => entry.runId === run.runId,
          )!;
          for (const entry of [current, threadHistory, allHistory]) {
            assert.equal(entry.status, operation === "complete" ? "completed" : "cancelled");
            assert.equal(entry.title, definition().title);
            assert.equal(entry.description, definition().description);
            assert.equal(entry.currentStepId, "research");
            assert.equal(entry.position, 1);
            assert.equal(entry.total, 3);
            assert.deepStrictEqual(
              entry.steps,
              definition().steps.map(({ id, title }) => ({ id, title })),
            );
            assert.notProperty(entry, "definition");
          }
          assert.deepStrictEqual(current.currentStep, definition().steps[0]);
          assert.notProperty(threadHistory, "currentStep");
          assert.notProperty(allHistory, "currentStep");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "prunes movement receipts only after termination and preserves start and finish retries",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot } = yield* makeFixture;
      const sql = yield* SqlClient.SqlClient;
      for (const operation of ["complete", "cancel"] as const) {
        const run = yield* store.start(owner, workspaceRoot, "demo", `start-${operation}`);
        const next = {
          operation: "next",
          runId: run.runId,
          expectedStepId: "research",
          client_request_id: `next-${operation}`,
        } as const;
        yield* store.mutate(owner, next);
        yield* store.mutate(owner, {
          operation: "back",
          runId: run.runId,
          expectedStepId: "implement",
          client_request_id: `back-${operation}`,
        });
        assert.isTrue((yield* store.mutate(owner, next)).replayed);
        assert.equal(
          (yield* sql`SELECT * FROM j5_playbook_request WHERE run_id = ${run.runId}`).length,
          3,
        );
        const finish = {
          operation,
          runId: run.runId,
          expectedStepId: "research",
          client_request_id: operation,
        } as const;
        yield* store.mutate(owner, finish);
        assert.equal(
          (yield* sql`SELECT * FROM j5_playbook_request WHERE run_id = ${run.runId}`).length,
          2,
        );
        assert.isTrue((yield* store.mutate(owner, finish)).replayed);
        assert.equal(
          (yield* store.start(owner, workspaceRoot, "demo", `start-${operation}`)).runId,
          run.runId,
        );
        assert.equal((yield* Effect.flip(store.mutate(owner, next))).code, "run_terminal");
      }
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "reads the source once outside the writer transaction and keeps the snapshot on replay and movement",
  () =>
    Effect.gen(function* () {
      const { workspaceRoot, fs } = yield* makeFixture;
      const sql = yield* SqlClient.SqlClient;
      let reads = 0;
      const store = yield* makePlaybookStore.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, encoding) =>
            Effect.gen(function* () {
              assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
              reads += 1;
              return yield* fs.readFileString(file, encoding);
            }),
        }),
      );
      const run = yield* store.start(owner, workspaceRoot, "demo", "start");
      assert.equal(reads, 1);
      yield* store.start(owner, workspaceRoot, "demo", "start");
      yield* store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: "next",
      });
      yield* store.current(owner);
      assert.equal(reads, 1);
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("enforces the shared byte and step limits at their boundaries", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, fs, filename, write } = yield* makeFixture;
    const ids = Array.from({ length: PLAYBOOK_MAX_STEPS }, (_, index) => `step-${index}`);
    yield* write("demo", definition(ids));
    assert.isNull((yield* store.discover(workspaceRoot)).playbooks[0]?.issue);
    yield* write("demo", definition([...ids, "too-many"]));
    assert.equal(
      (yield* Effect.flip(store.start(owner, workspaceRoot, "demo", "steps"))).code,
      "invalid_definition",
    );
    const yaml = stringify(definition()) + "#";
    yield* fs.writeFileString(filename("demo"), yaml.padEnd(PLAYBOOK_MAX_BYTES, " "));
    assert.isNull((yield* store.discover(workspaceRoot)).playbooks[0]?.issue);
    yield* fs.writeFileString(filename("demo"), yaml.padEnd(PLAYBOOK_MAX_BYTES + 1, " "));
    assert.equal(
      (yield* Effect.flip(store.start(owner, workspaceRoot, "demo", "bytes"))).code,
      "invalid_definition",
    );
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("exports the stem file name and a YAML body that imports back unchanged", () =>
  Effect.gen(function* () {
    const { fs, store, workspaceRoot, filename, write } = yield* makeFixture;
    const original: PlaybookDefinition = {
      title: "Title that is not the file name",
      description: "Colons: quotes \" and 'apostrophes' # not a comment",
      steps: [
        { id: "b-first", title: "Second alphabetically", prompt: "  leading and trailing  \n" },
        { id: "a-second", title: "Multiline", prompt: "Line one\n\nLine three: yes\n- not a list" },
      ],
    };
    yield* write("stem", original);
    const exported = yield* store.exportDefinition(workspaceRoot, "stem");
    assert.equal(exported.fileName, "stem.yaml");
    assert.notInclude(exported.fileName, "Title");
    // Importing writes the exported bytes under the file's stem, so the copy must decode identically.
    yield* fs.writeFileString(filename("copy"), exported.yaml);
    assert.deepStrictEqual(parse(exported.yaml), original);
    assert.deepStrictEqual(
      parse(yield* fs.readFileString(filename("copy"))),
      parse(yield* fs.readFileString(filename("stem"))),
    );
    const copy = (yield* store.discover(workspaceRoot)).playbooks.find(
      ({ name }) => name === "copy",
    );
    assert.isNull(copy?.issue);
    assert.deepStrictEqual(
      copy?.steps.map(({ id }) => id),
      ["b-first", "a-second"],
    );
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("rejects exports of missing, misnamed, and invalid definitions", () =>
  Effect.gen(function* () {
    const { fs, store, workspaceRoot, filename } = yield* makeFixture;
    const code = (name: string) =>
      store.exportDefinition(workspaceRoot, name).pipe(
        Effect.flip,
        Effect.map((error) => (error as { code?: string }).code),
      );
    assert.equal(yield* code("missing"), "not_found");
    assert.equal(yield* code("../demo"), "invalid_name");
    yield* fs.writeFileString(filename("broken"), "title: [broken");
    assert.equal(yield* code("broken"), "invalid_definition");
    yield* fs.writeFileString(
      filename("dupes"),
      stringify({
        ...definition(["same", "same"]),
      }),
    );
    assert.equal(yield* code("dupes"), "invalid_definition");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("keeps the workspace path out of export read failures", () =>
  Effect.gen(function* () {
    const { fs, store, workspaceRoot, filename } = yield* makeFixture;
    yield* fs.writeFileString(filename("broken"), "title: [broken");
    const error = yield* store.exportDefinition(workspaceRoot, "broken").pipe(Effect.flip);
    assert.equal((error as { code?: string }).code, "invalid_definition");
    assert.notInclude(error.message, workspaceRoot);
    assert.notInclude(error.message, "cancellation");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("exports a near-limit definition byte-for-byte so it stays importable", () =>
  Effect.gen(function* () {
    const { fs, store, workspaceRoot, filename } = yield* makeFixture;
    const source = `title: Demo\ndescription: Demo\nsteps:\n- id: one\n  title: One\n  prompt: "${"word ".repeat(50000)}end"\n`;
    assert.isBelow(Buffer.byteLength(source), PLAYBOOK_MAX_BYTES);
    yield* fs.writeFileString(filename("big"), source);
    const exported = yield* store.exportDefinition(workspaceRoot, "big");
    assert.equal(exported.yaml, source);
    assert.isAtMost(Buffer.byteLength(exported.yaml), PLAYBOOK_MAX_BYTES);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("refuses to export a playbook symlinked outside the workspace", () =>
  Effect.gen(function* () {
    const { fs, path, store, workspaceRoot, filename } = yield* makeFixture;
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-outside-" });
    const target = path.join(outside, "secret.yaml");
    yield* fs.writeFileString(target, stringify(definition()));
    yield* fs.symlink(target, filename("leak"));
    const error = yield* store.exportDefinition(workspaceRoot, "leak").pipe(Effect.flip);
    assert.equal((error as { code?: string }).code, "invalid_path");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

// A real environment catalog on a temp state directory, as the running server reads it.
const CatalogLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "j5-playbook-personas-",
}).pipe(Layer.provideMerge(MemoryLayer));
const staffed = (): PlaybookDefinition => ({
  ...definition(),
  steps: [
    { id: "research", title: "Research", prompt: "Follow research.", persona: "planner" },
    { id: "implement", title: "Implement", prompt: "Follow implement.", persona: "builder-bot" },
    { id: "review", title: "Review", prompt: "Follow review." },
  ],
});

it.effect("reads a definition without personas exactly as before, with no warnings", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const [entry] = (yield* store.discover(workspaceRoot)).playbooks;
    assert.deepStrictEqual(entry?.warnings, []);
    assert.deepStrictEqual(entry?.steps, [
      { id: "research", title: "Step research" },
      { id: "implement", title: "Step implement" },
      { id: "review", title: "Step review" },
    ]);
    const read = yield* store.read(workspaceRoot, "demo.yaml");
    const { source, digest, ...definitionRead } = read;
    assert.deepStrictEqual(definitionRead, { name: "demo", ...definition(), warnings: [] });
    assert.deepStrictEqual(source, { kind: "workspace" });
    assert.match(digest ?? "", /^[a-f0-9]{64}$/);
    assert.isFalse(read.steps.some((step) => "persona" in step));
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("returns step personas from discover, read, and every step tool", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write } = yield* makeFixture;
    yield* seedPersonas([
      { id: "planner", enabled: true },
      { id: "builder-bot", enabled: true },
    ]);
    yield* write("demo", staffed());
    const [entry] = (yield* store.discover(workspaceRoot)).playbooks;
    assert.deepStrictEqual(entry?.steps, [
      { id: "research", title: "Research", persona: "planner" },
      { id: "implement", title: "Implement", persona: "builder-bot" },
      { id: "review", title: "Review" },
    ]);
    assert.deepStrictEqual(entry?.warnings, []);
    assert.deepStrictEqual((yield* store.read(workspaceRoot, "demo")).steps, staffed().steps);

    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    assert.equal(run.currentStep?.persona, "planner");
    assert.equal((yield* store.current(owner)).currentStep?.persona, "planner");
    const next = yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "research",
      client_request_id: "next",
    });
    assert.equal(next.currentStep?.persona, "builder-bot");
    const back = yield* store.mutate(owner, {
      operation: "back",
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "back",
    });
    assert.equal(back.currentStep?.persona, "planner");
    const advanced = yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "research",
      client_request_id: "next-again",
    });
    assert.equal(advanced.currentStep?.persona, "builder-bot");
    // Progress on the board stays titles only.
    assert.deepStrictEqual(advanced.steps[0], { id: "research", title: "Research" });
  }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect("warns about a disabled or missing persona without invalidating the definition", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write } = yield* makeFixture;
    yield* seedPersonas([{ id: "planner", enabled: false }]);
    yield* write("demo", staffed());
    const expected = [
      {
        code: "persona_disabled",
        stepId: "research",
        persona: "planner",
        message: `Step "research" names persona "planner", which is turned off.`,
      },
      {
        code: "persona_missing",
        stepId: "implement",
        persona: "builder-bot",
        message: `Step "implement" names persona "builder-bot", which is not in this environment's library.`,
      },
    ];
    const [entry] = (yield* store.discover(workspaceRoot)).playbooks;
    assert.isNull(entry?.issue);
    assert.deepStrictEqual(entry?.warnings, expected);
    const read = yield* store.read(workspaceRoot, "demo");
    assert.deepStrictEqual(read.warnings, expected);
    assert.equal((yield* store.start(owner, workspaceRoot, "demo", "start")).status, "active");
  }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect("reports personas as unverified when the catalog cannot be read", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write, fs, path } = yield* makeFixture;
    const { stateDir } = yield* ServerConfig;
    // Invalid source files can hide the named personas from the partial catalog.
    yield* fs.makeDirectory(path.join(stateDir, "personas"));
    yield* fs.writeFileString(path.join(stateDir, "personas/broken.yaml"), "id: [");
    yield* write("demo", staffed());
    const [entry] = (yield* store.discover(workspaceRoot)).playbooks;
    assert.isNull(entry?.issue);
    assert.deepStrictEqual(
      entry?.warnings?.map(({ code, stepId }) => [code, stepId]),
      [
        ["persona_unverified", "research"],
        ["persona_unverified", "implement"],
      ],
    );
    assert.include(entry?.warnings?.[0]?.message, "could not be checked");
    assert.lengthOf((yield* store.read(workspaceRoot, "demo")).warnings, 2);
  }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect(
  "keeps known personas verified while invalid sources leave absent personas unverified",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, write, fs, path } = yield* makeFixture;
      yield* seedPersonas([
        { id: "planner", enabled: true },
        { id: "builder-bot", enabled: false },
      ]);
      const { stateDir } = yield* ServerConfig;
      const folder = path.join(stateDir, "personas");
      yield* fs.makeDirectory(folder, { recursive: true });
      const broken = path.join(folder, "broken.yaml");
      yield* fs.writeFileString(broken, "id: [");
      yield* write("demo", {
        ...staffed(),
        steps: staffed().steps.map((step) =>
          step.id === "review" ? { ...step, persona: "reviewer" } : step,
        ),
      });
      const [entry] = (yield* store.discover(workspaceRoot)).playbooks;
      assert.isNull(entry?.issue);
      assert.deepStrictEqual(
        entry?.warnings?.map(({ code, stepId }) => [code, stepId]),
        [
          ["persona_disabled", "implement"],
          ["persona_unverified", "review"],
        ],
      );
      assert.deepStrictEqual((yield* store.read(workspaceRoot, "demo")).warnings, entry?.warnings);
      assert.equal((yield* store.start(owner, workspaceRoot, "demo", "start")).status, "active");
      yield* fs.remove(broken);
      const repaired = yield* store.read(workspaceRoot, "demo");
      assert.deepStrictEqual(
        repaired.warnings.map(({ code, stepId }) => [code, stepId]),
        [
          ["persona_disabled", "implement"],
          ["persona_missing", "review"],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect("reports personas as unverified when persona configuration cannot be read", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write, fs, path } = yield* makeFixture;
    const { stateDir } = yield* ServerConfig;
    yield* fs.writeFileString(path.join(stateDir, "agent-personas.json"), "not json");
    yield* write("demo", staffed());
    const read = yield* store.read(workspaceRoot, "demo");
    assert.deepStrictEqual(
      read.warnings.map(({ code, stepId }) => [code, stepId]),
      [
        ["persona_unverified", "research"],
        ["persona_unverified", "implement"],
      ],
    );
    assert.include(read.warnings[0]?.message ?? "", "could not be checked");
  }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect("reads a playbook without creating a run or moving an active one", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "research",
      client_request_id: "next",
    });
    const revision = yield* Stream.runHead(store.changes);
    const runs = (yield* store.listForThread(owner)).runs.length;
    const read = yield* store.read(workspaceRoot, "demo");
    assert.deepStrictEqual(
      read.steps.map(({ prompt }) => prompt),
      ["Follow research.", "Follow implement.", "Follow review."],
    );
    assert.equal((yield* store.current(owner)).currentStepId, "implement");
    assert.lengthOf((yield* store.listForThread(owner)).runs, runs);
    assert.deepStrictEqual(yield* Stream.runHead(store.changes), revision);
    assert.equal((yield* Effect.flip(store.read(workspaceRoot, "absent"))).code, "not_found");
    assert.equal((yield* Effect.flip(store.read(workspaceRoot, "../demo"))).code, "invalid_name");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "moves its revision for each change a run's views show, and for no read that changed nothing",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, write } = yield* makeFixture;
      const sql = yield* SqlClient.SqlClient;
      const revision = store.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      /** Runs a store call and says how far it moved the revision. */
      const moved = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const before = yield* revision;
          yield* effect;
          return (yield* revision) - before;
        });

      // Library edits refresh discovery.
      assert.equal(yield* moved(store.renameDefinition(workspaceRoot, "demo", "Renamed")), 1);
      assert.equal(yield* moved(store.renameDefinition(workspaceRoot, "demo", "Renamed")), 0);
      yield* write("unused");
      assert.equal(yield* moved(store.removeDefinition(workspaceRoot, "unused")), 1);
      assert.equal(yield* moved(Effect.flip(store.removeDefinition(workspaceRoot, "unused"))), 0);

      // The first landing records the owner as holder in the start transaction.
      const run = yield* store.start(owner, workspaceRoot, "demo", "start");
      assert.equal((yield* store.landing(run.runId, "start"))?.targetThreadId, owner);
      assert.equal(yield* moved(store.resolveLanding(run.runId, "start", "captain")), 1);
      assert.equal(yield* moved(store.resolveLanding(run.runId, "start", "captain")), 0);

      // Reads cancel a run whose owner is gone. One that cancelled nothing moves nothing, or every
      // read would cause the next.
      assert.equal(yield* moved(store.listAll({})), 0);
      assert.equal(yield* moved(store.listForThread(owner)), 0);
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-09-23' WHERE thread_id = ${owner}`;
      assert.equal(yield* moved(store.listAll({})), 1);
      assert.equal(yield* moved(store.listAll({})), 0);
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("projects a compact active run for its owner without prompt bodies", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    assert.deepStrictEqual(yield* store.activeRunSummaries([owner, otherOwner]), [
      {
        ownerThreadId: owner,
        runId: run.runId,
        position: 1,
        total: 3,
        stepId: "research",
        stepTitle: "Step research",
        holderParticipantId: run.holderParticipantId,
        state: "captain",
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "saves an environment playbook across unrelated projects and worktrees without workspace copies",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, fs, path } = yield* makeFixture;
      const { stateDir } = yield* ServerConfig;
      const yaml = `# Keep this comment\n${stringify(definition())}`;
      assert.deepStrictEqual(yield* store.saveDefinition({ name: "shared", yaml }), {
        name: "shared",
        saved: true,
      });
      for (const root of [
        workspaceRoot,
        path.join(workspaceRoot, "other-project"),
        path.join(workspaceRoot, "worktree"),
      ]) {
        const discovered = yield* store.discover(root);
        assert.equal(
          discovered.playbooks.find((entry) => entry.name === "shared")?.source.kind,
          "environment",
        );
        assert.equal((yield* store.read(root, "shared")).title, "Test playbook");
        assert.isFalse(yield* fs.exists(path.join(root, ".j5/playbooks/shared.yaml")));
      }
      assert.equal(
        (yield* store.exportDefinition("", "shared", { kind: "environment" })).yaml,
        yaml,
      );
      const run = yield* store.start(owner, workspaceRoot, "shared", "start-shared");
      assert.equal(run.definitionPath, path.join(stateDir, "playbooks/shared.yaml"));

      assert.deepStrictEqual(yield* store.removeDefinition("", "shared", { kind: "environment" }), {
        deleted: true,
      });
    }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect(
  "keeps environment run retries pinned when a workspace override appears, including legacy start receipts",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, write, fs, path } = yield* makeFixture;
      yield* store.saveDefinition({ name: "shared", yaml: stringify(definition()) });
      const run = yield* store.start(owner, workspaceRoot, "shared", "retry-shared");
      yield* write("shared", { ...definition(), title: "Workspace override" });
      assert.equal((yield* store.read(workspaceRoot, "shared")).title, "Workspace override");
      const replayed = yield* store.start(owner, workspaceRoot, "shared", "retry-shared");
      assert.equal(replayed.runId, run.runId);
      assert.equal(replayed.definitionPath, run.definitionPath);
      assert.isTrue(replayed.replayed);
      assert.equal(replayed.title, "Test playbook");
      assert.equal(
        (yield* Effect.flip(store.start(owner, workspaceRoot, "demo", "retry-shared"))).code,
        "request_conflict",
      );
      // Existing workspace starts use the unchanged path-based receipt shape too.
      const legacy = yield* store.start(otherOwner, workspaceRoot, "demo", "legacy");
      yield* fs.remove(path.join(workspaceRoot, ".j5/playbooks/demo.yaml"));
      yield* store.saveDefinition({ name: "demo", yaml: stringify(definition(["new"])) });
      const legacyReplay = yield* store.start(otherOwner, workspaceRoot, "demo", "legacy");
      assert.equal(legacyReplay.definitionPath, legacy.definitionPath);
    }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect(
  "keeps workspace overrides authoritative and management actions on their selected source",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, filename, fs } = yield* makeFixture;
      yield* store.saveDefinition({
        name: "demo",
        yaml: stringify({ ...definition(), title: "Shared demo" }),
      });
      const listed = (yield* store.discover(workspaceRoot)).playbooks.find(
        (entry) => entry.name === "demo",
      );
      assert.isTrue(listed?.overridesLibrary);
      yield* store.renameDefinition(workspaceRoot, "demo", "Renamed environment", {
        kind: "environment",
      });
      assert.equal((yield* store.read(workspaceRoot, "demo")).title, "Test playbook");
      assert.include(
        (yield* store.exportDefinition(workspaceRoot, "demo", { kind: "environment" })).yaml,
        "Renamed environment",
      );
      yield* fs.writeFileString(filename("demo"), "broken: [");
      assert.equal(
        (yield* Effect.flip(store.read(workspaceRoot, "demo"))).code,
        "invalid_definition",
      );
      yield* fs.remove(filename("demo"));
      yield* fs.symlink(`${filename("demo")}.missing`, filename("demo"));
      assert.equal((yield* Effect.flip(store.read(workspaceRoot, "demo"))).code, "not_found");
      assert.equal(
        (yield* store.discover(workspaceRoot)).playbooks.find((entry) => entry.name === "demo")
          ?.issue?.code,
        "invalid_definition",
      );
      yield* store.removeDefinition("", "demo", { kind: "environment" });
      assert.include(yield* fs.readDirectory(`${workspaceRoot}/.j5/playbooks`), "demo.yaml");
    }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect(
  "reads configured folders, reports ambiguous names, and retains pinned runs after a source is removed",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, fs, path, write } = yield* makeFixture;
      const { stateDir } = yield* ServerConfig;
      const folder = path.join(stateDir, "external");
      yield* fs.makeDirectory(folder);
      yield* fs.writeFileString(path.join(folder, "shared.yaml"), stringify(definition()));
      const alias = path.join(stateDir, "external-alias");
      yield* fs.symlink(folder, alias);
      yield* store.setFolders({ folders: ["external", folder, alias] });
      assert.equal((yield* store.sources()).folders.length, 2);
      const run = yield* store.start(owner, workspaceRoot, "shared", "folder-run");
      assert.equal(run.definitionPath, path.join(folder, "shared.yaml"));
      assert.equal(
        (yield* Effect.flip(
          store.removeDefinition("", "shared", { kind: "folder", path: "external" }),
        )).code,
        "read_only",
      );
      yield* fs.makeDirectory(path.join(stateDir, "playbooks"), { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "playbooks/shared.yaml"),
        stringify(definition()),
      );
      assert.equal(
        (yield* Effect.flip(store.read(workspaceRoot, "shared"))).code,
        "duplicate_name",
      );
      assert.equal(
        (yield* store.discover(workspaceRoot)).playbooks.find((entry) => entry.name === "shared")
          ?.issue?.code,
        "duplicate_name",
      );
      assert.equal((yield* store.read(workspaceRoot, "demo")).title, "Test playbook");
      yield* write("shared", { ...definition(), title: "Local" });
      assert.equal((yield* store.read(workspaceRoot, "shared")).title, "Local");
      yield* store.setFolders({ folders: [] });
      assert.equal(
        (yield* store.current(owner, run.runId)).definitionPath,
        path.join(folder, "shared.yaml"),
      );

      assert.equal(
        (yield* store.start(owner, workspaceRoot, "shared", "folder-run")).runId,
        run.runId,
      );
      assert.equal(
        (yield* Effect.flip(
          store.exportDefinition("", "shared", { kind: "folder", path: "external" }),
        )).code,
        "source_not_found",
      );
      assert.isTrue(yield* fs.exists(path.join(folder, "shared.yaml")));
    }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect(
  "shows missing folders and malformed config while keeping workspace playbooks usable",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, fs, path } = yield* makeFixture;
      const { stateDir } = yield* ServerConfig;
      yield* store.saveDefinition({ name: "shared", yaml: stringify(definition()) });
      const folder = path.join(stateDir, "missing-later");
      yield* fs.makeDirectory(folder);
      yield* store.setFolders({ folders: [folder] });
      yield* fs.remove(folder, { recursive: true });
      assert.equal(
        (yield* store.sources()).folders.find((entry) => entry.source.kind === "folder")?.issue
          ?.code,
        "source_unavailable",
      );
      assert.equal(
        (yield* Effect.flip(store.read(workspaceRoot, "shared"))).code,
        "source_unavailable",
      );
      assert.equal((yield* store.read(workspaceRoot, "demo")).title, "Test playbook");
      yield* fs.writeFileString(path.join(stateDir, "playbooks.json"), "bad json");
      const listed = yield* store.discover(workspaceRoot);
      assert.equal(listed.playbooks.find((entry) => entry.name === "demo")?.issue, null);
      assert.isTrue(listed.sources.some((entry) => entry.issue?.code === "invalid_configuration"));
      assert.equal(
        (yield* Effect.flip(store.read(workspaceRoot, "shared"))).code,
        "invalid_configuration",
      );
    }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect("edits an environment playbook only with the digest of the version that was read", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot } = yield* makeFixture;
    yield* store.saveDefinition({ name: "shared", yaml: stringify(definition()) });
    const read = yield* store.read(workspaceRoot, "shared");
    assert.deepStrictEqual(read.source, { kind: "environment" });
    const edited = stringify(definition(["first", "added"]));
    assert.deepStrictEqual(
      yield* store.saveDefinition({ name: "shared", yaml: edited, expectedDigest: read.digest! }),
      { name: "shared", saved: true },
    );
    assert.deepStrictEqual(
      (yield* store.read(workspaceRoot, "shared")).steps.map((step) => step.id),
      ["first", "added"],
    );
    // The digest now names an older version, so a second edit from the same read is refused.
    assert.equal(
      (yield* Effect.flip(
        store.saveDefinition({
          name: "shared",
          yaml: stringify(definition(["other"])),
          expectedDigest: read.digest!,
        }),
      )).code,
      "stale_digest",
    );
    // A workspace playbook is edited in its file, never through the library.
    const local = yield* store.read(workspaceRoot, "demo");
    assert.deepStrictEqual(local.source, { kind: "workspace" });
    assert.equal(
      (yield* Effect.flip(
        store.saveDefinition({ name: "demo", yaml: edited, expectedDigest: local.digest! }),
      )).code,
      "not_found",
    );
  }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect(
  "validates environment saves, preserves exact retries, and never replaces an existing definition",
  () =>
    Effect.gen(function* () {
      const { store, fs, path } = yield* makeFixture;
      const { stateDir } = yield* ServerConfig;
      const yaml = stringify(definition());
      yield* store.saveDefinition({ name: "shared", yaml });
      assert.deepStrictEqual(yield* store.saveDefinition({ name: "shared", yaml }), {
        name: "shared",
        saved: false,
      });
      assert.equal(
        (yield* Effect.flip(
          store.saveDefinition({ name: "shared", yaml: stringify(definition(["changed"])) }),
        )).code,
        "already_exists",
      );
      for (const value of [
        "invalid: [",
        stringify(definition(["duplicate", "duplicate"])),
        `#${"é".repeat(PLAYBOOK_MAX_BYTES)}\n${yaml}`,
      ]) {
        assert.equal(
          (yield* Effect.flip(store.saveDefinition({ name: "invalid", yaml: value }))).code,
          "invalid_definition",
        );
      }
      assert.equal(
        (yield* Effect.flip(store.saveDefinition({ name: "../escape", yaml }))).code,
        "invalid_name",
      );
      assert.equal(yield* fs.readFileString(path.join(stateDir, "playbooks/shared.yaml")), yaml);
      assert.isFalse(yield* fs.exists(path.join(stateDir, "playbooks/invalid.yaml")));
      // Recreating the store reloads the same library files.
      const restarted = yield* makePlaybookStore;
      assert.equal((yield* restarted.read("", "shared")).title, "Test playbook");
    }).pipe(Effect.scoped, Effect.provide(CatalogLayer)),
);

it.effect("shows legacy terminal history without consulting its definition file", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, fs, filename } = yield* makeFixture;
    const sql = yield* SqlClient.SqlClient;
    const run = yield* store.start(owner, workspaceRoot, "demo", "legacy-history");
    yield* sql`UPDATE j5_playbook_run SET status = 'cancelled', definition_json = NULL,
      cancel_reason = 'started before runs kept their own copy; start it again.' WHERE run_id = ${run.runId}`;
    yield* fs.remove(filename("demo"));
    const history = (yield* store.listForThread(owner)).runs[0]!;
    assert.equal(history.title, "demo");
    assert.equal(history.status, "cancelled");
    assert.equal(history.currentStepId, "research");
    assert.equal(history.cancelReason, "started before runs kept their own copy; start it again.");
    assert.deepStrictEqual(history.steps, []);
    assert.isNull(history.position);
    assert.isFalse(history.waitingForApproval);
    assert.isFalse(history.blocked);
    assert.notProperty(history, "definition");
    assert.notProperty(history, "currentStep");
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("revises only the owner's run copy and records an idempotent attributed revision", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, fs, filename } = yield* makeFixture;
    const saved = yield* fs.readFileString(filename("demo"));
    const run = yield* store.start(owner, workspaceRoot, "demo", "revision-start");
    const other = yield* store.start(otherOwner, workspaceRoot, "demo", "other-start");
    const input = {
      operation: "revise" as const,
      runId: run.runId,
      expectedStepId: "research",
      steps: definition(["review", "research", "added"]).steps,
      basis: "asked" as const,
      client_request_id: "revision",
    };
    assert.equal((yield* Effect.flip(store.mutate(otherOwner, input))).code, "not_owner");
    assert.equal(
      (yield* Effect.flip(store.mutate(owner, { ...input, expectedStepId: "stale" }))).code,
      "step_conflict",
    );
    for (const steps of [
      [],
      [input.steps[0]!, input.steps[0]!],
      [{ id: "x", title: "X", prompt: "x".repeat(PLAYBOOK_MAX_BYTES) }],
    ]) {
      assert.equal(
        (yield* Effect.flip(store.mutate(owner, { ...input, steps }))).code,
        "invalid_definition",
      );
      assert.deepStrictEqual((yield* store.current(owner)).steps, run.steps);
    }
    const revised = yield* store.mutate(owner, input);
    assert.equal(revised.currentStepId, "research");
    assert.equal(revised.position, 2);
    assert.equal(revised.revisionCount, 1);
    assert.equal(revised.latestRevision?.basis, "asked");
    assert.equal(revised.latestRevision?.ownerThreadId, owner);
    assert.equal(revised.latestRevision?.revisedAt, revised.updatedAt);
    assert.deepStrictEqual((yield* store.current(otherOwner, other.runId)).steps, other.steps);
    assert.equal(yield* fs.readFileString(filename("demo")), saved);
    const restarted = yield* makePlaybookStore;
    assert.deepStrictEqual((yield* restarted.current(owner)).steps, revised.steps);
    assert.isTrue((yield* restarted.mutate(owner, input)).replayed);
    assert.equal(
      (yield* Effect.flip(store.mutate(owner, { ...input, basis: "approved" }))).code,
      "request_conflict",
    );
    assert.equal(
      (yield* Effect.flip(
        store.mutate(owner, { ...input, steps: definition(["different"]).steps }),
      )).code,
      "request_conflict",
    );
    const sql = yield* SqlClient.SqlClient;
    const history = yield* sql<{
      basis: string;
      owner_thread_id: string;
    }>`SELECT * FROM j5_playbook_revision WHERE run_id = ${run.runId}`;
    assert.equal(history.length, 1);
    assert.equal(history[0]?.basis, "asked");
    assert.equal(history[0]?.owner_thread_id, owner);
    const second = yield* store.mutate(owner, {
      ...input,
      client_request_id: "second-revision",
      basis: "approved",
      stepId: "added",
    });
    assert.equal(second.currentStepId, "research");
    assert.equal(second.revisionCount, 2);
    assert.equal(second.latestRevision?.basis, "approved");
    const originalRetry = yield* store.mutate(owner, input);
    assert.isTrue(originalRetry.replayed);
    assert.equal(originalRetry.revisionCount, 2);
    assert.equal(originalRetry.latestRevision?.basis, "approved");
    const allHistory = yield* sql`SELECT * FROM j5_playbook_revision WHERE run_id = ${run.runId}`;
    assert.equal(allHistory.length, 2);
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "requires a replacement when revising away the current step and refuses terminal revisions",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot } = yield* makeFixture;
      const run = yield* store.start(owner, workspaceRoot, "demo", "start");
      const input = {
        operation: "revise" as const,
        runId: run.runId,
        expectedStepId: "research",
        steps: definition(["implement", "review"]).steps,
        basis: "approved" as const,
        client_request_id: "replace",
      };
      for (const stepId of [undefined, "absent"]) {
        assert.equal(
          (yield* Effect.flip(store.mutate(owner, { ...input, ...(stepId ? { stepId } : {}) })))
            .code,
          "step_missing",
        );
        assert.equal((yield* store.current(owner)).currentStepId, "research");
      }
      const revised = yield* store.mutate(owner, { ...input, stepId: "review" });
      assert.equal(revised.currentStepId, "review");
      assert.equal(revised.latestRevision?.basis, "approved");
      yield* store.mutate(owner, {
        operation: "complete",
        runId: run.runId,
        expectedStepId: "review",
        client_request_id: "complete",
      });
      assert.equal(
        (yield* Effect.flip(store.mutate(owner, { ...input, client_request_id: "terminal" }))).code,
        "run_terminal",
      );
      assert.equal((yield* store.listForThread(owner)).runs[0]?.revisionCount, 1);
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect(
  "gates checkpoint departures once per visit, persists answers, and rejects obsolete approval",
  () =>
    Effect.gen(function* () {
      const { store, workspaceRoot, write } = yield* makeFixture;
      const checked = {
        ...definition(["plan", "build"]),
        steps: definition(["plan", "build"]).steps.map((step) => ({
          ...step,
          approval: "required" as const,
        })),
      };
      yield* write("demo", checked);
      const run = yield* store.start(owner, workspaceRoot, "demo", "checkpoint-start");
      const leave = {
        operation: "next" as const,
        runId: run.runId,
        expectedStepId: "plan",
        client_request_id: "checkpoint-next",
        summary: "Plan and tradeoffs are ready.",
      };
      assert.equal((yield* Effect.flip(store.mutate(owner, leave))).code, "approval_pending");
      const progress = () => store.listForThread(owner).pipe(Effect.map(({ runs }) => runs[0]!));
      const first = (yield* store.current(owner)).checkpoint!;
      assert.isTrue((yield* progress()).waitingForApproval);
      assert.isFalse((yield* progress()).blocked, "a checkpoint is not an ordinary ask");
      assert.notProperty(yield* progress(), "checkpoint");
      assert.notInclude(JSON.stringify(yield* progress()), leave.summary);
      assert.equal(
        (yield* Effect.flip(store.mutate(owner, { ...leave, expectedStepId: "wrong" }))).code,
        "step_conflict",
      );
      for (const [index, steps] of [
        checked.steps.slice(1),
        definition(["plan", "build"]).steps,
      ].entries()) {
        assert.equal(
          (yield* Effect.flip(
            store.mutate(owner, {
              operation: "revise",
              runId: run.runId,
              expectedStepId: "plan",
              stepId: "build",
              steps,
              basis: "approved",
              client_request_id: `drop-checkpoint-${index}`,
            }),
          )).code,
          "invalid_definition",
        );
        assert.deepStrictEqual((yield* store.current(owner)).checkpoint, first);
      }
      assert.equal(first.summary, leave.summary);
      assert.equal(first.ownerThreadId, owner);
      assert.equal(first.stepTitle, "Step plan");
      assert.equal(
        (yield* Effect.flip(store.mutate(owner, { ...leave, client_request_id: "repeat" }))).code,
        "approval_pending",
      );
      assert.equal((yield* store.pendingCheckpoints({ kind: "service" })).length, 1);
      const restarted = yield* makePlaybookStore;
      assert.deepStrictEqual((yield* restarted.current(owner)).checkpoint, first);
      const handlersFor = (level: "owner" | "collaborator" | "viewer") =>
        makeCheckpointRpcHandlers({
          sessionId: AuthSessionId.make(`session:${level}`),
          subject: "one-time-token",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(PlaybookStore, store),
              Layer.mock(PersonAccess)({
                sessionReach: () =>
                  Effect.succeed({
                    kind: "person",
                    person: {
                      personId: ParticipantId.make(`human:${level}`),
                      displayName: level,
                      firstOwner: level === "owner",
                    },
                    levels: [],
                    serverLevel: level,
                    highest: level,
                    ceiling: null,
                  }),
              }),
              Layer.mock(SharedThreads)({ writerLevel: () => Effect.succeed(null) }),
            ),
          ),
        );
      const viewer = yield* handlersFor("viewer");
      assert.deepStrictEqual(yield* viewer[J5_PLAYBOOK_WS_METHODS.countCheckpoints](), {
        count: 1,
      });
      assert.equal((yield* viewer[J5_PLAYBOOK_WS_METHODS.listCheckpoints]({})).requests.length, 1);
      assert.equal(
        (yield* Effect.flip(
          viewer[J5_PLAYBOOK_WS_METHODS.answerCheckpoint]({
            threadId: owner,
            requestId: first.requestId,
            decision: "approve",
          }),
        )).code,
        "operation_failed",
      );
      const collaborator = yield* handlersFor("collaborator");
      yield* collaborator[J5_PLAYBOOK_WS_METHODS.answerCheckpoint]({
        threadId: owner,
        requestId: first.requestId,
        decision: "decline",
        reason: "Add rollback instructions.",
      });
      assert.equal(
        (yield* restarted.current(owner)).checkpoint?.reason,
        "Add rollback instructions.",
      );
      assert.isFalse((yield* progress()).waitingForApproval, "declining clears waiting");
      const dispatched = yield* Ref.make<
        ReadonlyArray<Parameters<ThreadManagementService["Service"]["dispatch"]>[0]>
      >([]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO j5_playbook_checkpoint
        SELECT 'retry-notice', run_id, owner_thread_id, step_id, step_title, summary,
               'approved', created_at, answered_at, reason, NULL
        FROM j5_playbook_checkpoint WHERE request_id = ${first.requestId}`;
      let failDispatch = true;
      const notifier = yield* makeCheckpointNotifications.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(PlaybookStore, restarted),
            Layer.mock(ThreadManagementService)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: { archivedAt: null, deletedAt: null },
                } as OrchestrationV2ThreadProjection),
              dispatch: (command) =>
                failDispatch && command.commandId === "playbook-checkpoint:retry-notice"
                  ? Effect.die("temporary dispatch failure")
                  : Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                      Effect.as({ sequence: 1, storedEvents: [] }),
                    ),
            }),
          ),
        ),
      );
      assert.isTrue(yield* notifier.drain());
      const notice = (yield* Ref.get(dispatched))[0]!;
      assert.equal(notice.type, "message.dispatch");
      if (notice.type === "message.dispatch") {
        assert.equal(notice.threadId, owner);
        assert.include(notice.text, "Add rollback instructions.");
      }
      failDispatch = false;
      assert.isFalse(yield* notifier.drain());
      assert.equal((yield* Ref.get(dispatched)).length, 2);
      yield* sql`UPDATE j5_playbook_checkpoint SET notified_at = NULL WHERE request_id = ${first.requestId}`;
      yield* notifier.drain();
      assert.deepStrictEqual((yield* Ref.get(dispatched))[2], notice);
      assert.equal(
        (yield* Effect.flip(
          store.answerCheckpoint({
            threadId: owner,
            requestId: first.requestId,
            decision: "approve",
          }),
        )).code,
        "already_answered",
      );
      assert.equal((yield* Effect.flip(store.mutate(owner, leave))).code, "approval_pending");
      const second = (yield* store.current(owner)).checkpoint!;
      assert.isTrue((yield* progress()).waitingForApproval);
      assert.notEqual(second.requestId, first.requestId);
      yield* collaborator[J5_PLAYBOOK_WS_METHODS.answerCheckpoint]({
        threadId: owner,
        requestId: second.requestId,
        decision: "approve",
      });
      assert.equal((yield* restarted.current(owner)).checkpoint?.status, "approved");
      assert.isFalse((yield* progress()).waitingForApproval, "approving clears waiting");
      // Same work with a new holder keeps the approval.
      yield* store.mutate(owner, {
        operation: "assign",
        runId: run.runId,
        expectedStepId: "plan",
        client_request_id: "assign-approved",
      });
      assert.equal((yield* store.current(owner)).checkpoint?.status, "approved");
      yield* store.mutate(owner, leave);
      const { summary: submittedSummary, ...withoutSummary } = leave;
      assert.equal(
        (yield* Effect.flip(store.mutate(owner, { ...withoutSummary, assignee: submittedSummary })))
          .code,
        "request_conflict",
      );
      yield* store.mutate(owner, {
        operation: "back",
        runId: run.runId,
        expectedStepId: "build",
        client_request_id: "back-checkpoint",
      });
      assert.equal(
        (yield* Effect.flip(store.mutate(owner, { ...leave, client_request_id: "revisit" }))).code,
        "approval_pending",
      );
      const revisit = (yield* store.current(owner)).checkpoint!;
      assert.notEqual(revisit.requestId, second.requestId);
      assert.isTrue((yield* progress()).waitingForApproval);
      const revisedSteps = checked.steps.map((step) =>
        step.id === "plan" ? { ...step, prompt: "A different plan." } : step,
      );
      yield* store.mutate(owner, {
        operation: "revise",
        runId: run.runId,
        expectedStepId: "plan",
        steps: revisedSteps,
        basis: "asked",
        client_request_id: "change-work",
      });
      assert.isFalse(
        (yield* progress()).waitingForApproval,
        "superseding the request clears waiting",
      );
      assert.equal(
        (yield* Effect.flip(
          store.answerCheckpoint({
            threadId: owner,
            requestId: revisit.requestId,
            decision: "approve",
          }),
        )).code,
        "already_answered",
      );
      assert.equal(
        (yield* Effect.flip(store.mutate(owner, { ...leave, client_request_id: "changed-work" })))
          .code,
        "approval_pending",
      );
      const changed = (yield* store.current(owner)).checkpoint!;
      const ownerHandlers = yield* handlersFor("owner");
      yield* ownerHandlers[J5_PLAYBOOK_WS_METHODS.answerCheckpoint]({
        threadId: owner,
        requestId: changed.requestId,
        decision: "approve",
      });
      yield* store.mutate(owner, { ...leave, client_request_id: "approved-change" });
      const complete = {
        operation: "complete" as const,
        runId: run.runId,
        expectedStepId: "build",
        client_request_id: "finish-checkpoint",
        summary: "Implementation tested.",
      };
      assert.equal((yield* Effect.flip(store.mutate(owner, complete))).code, "approval_pending");
      assert.equal((yield* store.current(owner)).currentStepId, "build");
      const last = (yield* store.current(owner)).checkpoint!;
      yield* store.mutate(owner, {
        operation: "cancel",
        runId: run.runId,
        client_request_id: "cancel-checkpoint",
      });
      assert.isFalse((yield* progress()).waitingForApproval, "cancelling clears waiting");
      assert.deepStrictEqual(yield* store.pendingCheckpoints({ kind: "service" }), []);
      assert.equal(
        (yield* Effect.flip(
          store.answerCheckpoint({
            threadId: owner,
            requestId: last.requestId,
            decision: "approve",
          }),
        )).code,
        "already_answered",
      );
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("completion needs approval and owner cancellation closes its pending checkpoint", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write } = yield* makeFixture;
    yield* write("demo", {
      ...definition(["report"]),
      steps: [{ ...definition(["report"]).steps[0]!, approval: "required" }],
    });
    const run = yield* store.start(owner, workspaceRoot, "demo", "last-start");
    const finish = {
      operation: "complete" as const,
      runId: run.runId,
      expectedStepId: "report",
      client_request_id: "last-finish",
    };
    assert.equal(
      (yield* Effect.flip(store.mutate(owner, finish))).code,
      "approval_summary_required",
    );
    assert.deepStrictEqual(yield* store.pendingCheckpoints({ kind: "service" }), []);
    assert.equal(
      (yield* Effect.flip(store.mutate(owner, { ...finish, summary: "Report attached." }))).code,
      "approval_pending",
    );
    const request = (yield* store.current(owner)).checkpoint!;
    yield* store.answerCheckpoint({
      threadId: owner,
      requestId: request.requestId,
      decision: "approve",
    });
    const amended = { ...finish, summary: "Report and appendix attached." };
    assert.equal((yield* Effect.flip(store.mutate(owner, amended))).code, "approval_pending");
    const replacement = (yield* store.current(owner)).checkpoint!;
    assert.notEqual(replacement.requestId, request.requestId);
    assert.equal(replacement.summary, amended.summary);
    yield* store.answerCheckpoint({
      threadId: owner,
      requestId: replacement.requestId,
      decision: "approve",
    });
    assert.equal((yield* store.mutate(owner, finish)).status, "completed");
    const sql = yield* SqlClient.SqlClient;
    for (const reason of ["owner_archived", "owner_deleted"] as const) {
      for (const recovered of [false, true]) {
        yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = NULL, deleted_at = NULL WHERE thread_id = ${owner}`;
        const key = `${reason}-${recovered}`;
        const orphan = yield* store.start(owner, workspaceRoot, "demo", `${key}-start`);
        assert.equal(
          (yield* Effect.flip(
            store.mutate(owner, {
              ...finish,
              runId: orphan.runId,
              client_request_id: `${key}-finish`,
              summary: "Review this.",
            }),
          )).code,
          "approval_pending",
        );
        const pending = (yield* store.current(owner)).checkpoint!;
        if (recovered) {
          const column = reason === "owner_archived" ? "archived_at" : "deleted_at";
          yield* sql`UPDATE orchestration_v2_projection_threads SET ${sql(column)} = '2026-11-17T00:00:00Z' WHERE thread_id = ${owner}`;
        } else yield* store.cancelOwner(owner, reason);
        assert.deepStrictEqual(yield* store.pendingCheckpoints({ kind: "service" }), []);
        const ended = yield* store.current(owner);
        assert.equal(ended.status, "cancelled");
        assert.equal(ended.cancelReason, reason);
        assert.isNull(ended.checkpoint);
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM j5_playbook_checkpoint WHERE request_id = ${pending.requestId}`,
          [{ status: "closed" }],
        );
        yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = NULL, deleted_at = NULL WHERE thread_id = ${owner}`;
        assert.equal(
          (yield* Effect.flip(
            store.answerCheckpoint({
              threadId: owner,
              requestId: pending.requestId,
              decision: "approve",
            }),
          )).code,
          "already_answered",
        );
      }
    }
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("counts and lists only pending checkpoints on reachable threads", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write } = yield* makeFixture;
    const sql = yield* SqlClient.SqlClient;
    const personId = ParticipantId.make("human:checkpoint-reader");
    yield* sql`INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
      VALUES (${personId}, 0, 'now')`;
    yield* sql`INSERT INTO j5_a2a_person_level (person_id, scope_kind, scope_id, level, created_at, updated_at)
      VALUES (${personId}, 'thread', ${owner}, 'viewer', 'now', 'now')`;
    const reader = {
      kind: "person",
      person: { personId, displayName: "Reader", firstOwner: false },
      levels: [{ scope: { kind: "thread", threadId: owner }, level: "viewer" }],
      serverLevel: null,
      highest: "viewer",
      ceiling: null,
    } as const;
    const original = definition(["plan"]);
    yield* write("demo", {
      ...original,
      steps: original.steps.map((step) => ({ ...step, approval: "required" })),
    });
    for (const threadId of [owner, otherOwner]) {
      const run = yield* store.start(threadId, workspaceRoot, "demo", "start");
      yield* Effect.flip(
        store.mutate(threadId, {
          operation: "complete",
          runId: run.runId,
          expectedStepId: "plan",
          client_request_id: "finish",
          summary: "Ready for approval.",
        }),
      );
    }
    assert.deepStrictEqual(
      (yield* store.pendingCheckpoints(reader)).map((row) => row.ownerThreadId),
      [owner],
    );
    assert.deepStrictEqual(yield* store.pendingCheckpoints(reader, otherOwner), []);
    assert.deepStrictEqual(yield* store.countCheckpoints(reader), { count: 1 });
    assert.deepStrictEqual(yield* store.countCheckpoints({ kind: "service" }), { count: 2 });
    assert.deepStrictEqual(yield* store.countCheckpoints({ kind: "unknown" }), { count: 0 });
  }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("drains checkpoint answers using the outstanding-notification index", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const sql = yield* SqlClient.SqlClient;
    const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN ${unnotifiedCheckpoints(sql)}`;
    assert.isTrue(
      plan.some((row) => row.detail.includes("j5_playbook_checkpoint_unnotified")),
      JSON.stringify(plan),
    );
  }).pipe(Effect.provide(MemoryLayer)),
);

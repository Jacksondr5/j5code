import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { PLAYBOOK_RUNS_PAGE_SIZE, type PlaybookDefinition } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { stringify } from "yaml";

import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { makePlaybookStore, type PlaybookMutation } from "./PlaybookStore.ts";

const owner = ThreadId.make("thread:playbook:owner");
const otherOwner = ThreadId.make("thread:playbook:other");
const MemoryLayer = Layer.mergeAll(NodeSqliteClient.layerMemory(), NodeServices.layer);
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
  return yield* makePlaybookStore;
});

const makeFixture = Effect.gen(function* () {
  const workspace = yield* makeWorkspace;
  const store = yield* initializeStore;
  return { ...workspace, store };
});

it.effect(
  "lists owners together, filters active runs, and reads shared live definitions once per page",
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
      assert.equal(reads, 1);
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
      assert.isTrue((yield* store.listAll({})).runs.every((run) => run.title === "Edited live"));
      yield* write("healthy");
      yield* store.start(ThreadId.make("healthy-owner"), workspaceRoot, "healthy", "healthy");
      yield* fs.writeFileString(filename("demo"), "title: [invalid");
      reads = 0;
      const broken = yield* store.listAll({});
      assert.equal(reads, 2);
      assert.equal(broken.runs.length, 3);
      assert.equal(broken.runs.filter((run) => run.issue?.code === "invalid_definition").length, 2);
      assert.equal(broken.runs.filter((run) => run.issue === null).length, 1);
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("reads one definition for twenty thread runs on each request", () =>
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
    assert.equal(reads, 1);
    assert.isFalse(first.runs.some((run) => "currentStep" in run));
    yield* write("demo", { ...definition(), title: "Changed title" });
    const second = yield* store.listForThread(owner);
    assert.equal(reads, 2);
    assert.isTrue(second.runs.every((run) => run.title === "Changed title"));
    yield* fs.writeFileString(filename("demo"), "title: [invalid");
    const broken = yield* store.listForThread(owner);
    assert.equal(reads, 3);
    assert.isTrue(broken.runs.every((run) => run.issue?.code === "invalid_definition"));
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

it.effect(
  "reads prompt edits live and navigates the latest order without changing the current ID",
  () =>
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
      assert.equal(current.description, "Updated purpose.");
      assert.equal(current.currentStep?.prompt, "Use the revised implementation instructions.");

      const next = yield* store.mutate(owner, {
        operation: "next",
        runId: run.runId,
        expectedStepId: "implement",
        client_request_id: "next-edited",
      });
      assert.equal(next.currentStepId, "research");
      assert.equal(next.position, 3);
      const back = yield* store.mutate(owner, {
        operation: "back",
        runId: run.runId,
        expectedStepId: "research",
        client_request_id: "back-edited",
      });
      assert.equal(back.currentStep?.prompt, "Use the revised implementation instructions.");
      const board = (yield* store.listForThread(owner)).runs[0]!;
      assert.deepStrictEqual(
        board.steps.map(({ id }) => id),
        ["review", "implement", "research"],
      );
      assert.notProperty(board, "currentStep");
      assert.isFalse(board.steps.some((step) => "prompt" in step));
    }).pipe(Effect.scoped, Effect.provide(MemoryLayer)),
);

it.effect("requires explicit recovery when the current step disappears", () =>
  Effect.gen(function* () {
    const { store, workspaceRoot, write } = yield* makeFixture;
    const run = yield* store.start(owner, workspaceRoot, "demo", "start");
    yield* write("demo", definition(["implement", "review"]));
    const missing = yield* Effect.flip(store.current(owner));
    assert.equal(missing.code, "step_missing");
    assert.include(missing.message, run.runId);
    assert.include(missing.message, "research");
    assert.include(missing.message, "playbook_reselect");
    assert.deepStrictEqual(missing.availableStepIds, ["implement", "review"]);
    for (const operation of ["next", "back", "complete"] as const) {
      assert.equal(
        (yield* Effect.flip(
          store.mutate(owner, {
            operation,
            runId: run.runId,
            expectedStepId: "research",
            client_request_id: operation,
          }),
        )).code,
        "step_missing",
      );
    }
    const before = (yield* store.listForThread(owner)).runs[0]!;
    assert.equal(before.currentStepId, "research");
    assert.equal(before.status, "active");
    assert.isNull(before.position);
    assert.equal(before.issue?.code, "step_missing");
    assert.equal(
      (yield* Effect.flip(
        store.mutate(owner, {
          operation: "reselect",
          runId: run.runId,
          expectedStepId: "research",
          stepId: "unknown",
          client_request_id: "invalid-reselect",
        }),
      )).code,
      "step_missing",
    );
    assert.equal(
      (yield* Effect.flip(
        store.mutate(owner, {
          operation: "reselect",
          runId: run.runId,
          expectedStepId: "implement",
          stepId: "review",
          client_request_id: "stale-reselect",
        }),
      )).code,
      "step_conflict",
    );
    const recovered = yield* store.mutate(owner, {
      operation: "reselect",
      runId: run.runId,
      expectedStepId: "research",
      stepId: "review",
      client_request_id: "recover",
    });
    assert.equal(recovered.currentStepId, "review");
    assert.equal(recovered.position, 2);
    assert.equal(recovered.currentStep?.prompt, "Follow review.");
    assert.isNull(recovered.issue);
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
        (yield* Effect.flip(store.current(owner, run.runId))).code,
        "invalid_definition",
      );
      for (const operation of ["next", "back", "complete"] as const) {
        assert.equal(
          (yield* Effect.flip(
            store.mutate(owner, {
              operation,
              runId: run.runId,
              expectedStepId: "research",
              client_request_id: `${operation}-${broken}`,
            }),
          )).code,
          "invalid_definition",
        );
      }
      const board = (yield* store.listForThread(owner)).runs[0]!;
      assert.equal(board.currentStepId, "research");
      assert.equal(board.status, "active");
      assert.equal(board.issue?.code, "invalid_definition");
      const cancelled = yield* store.mutate(owner, {
        operation: "cancel",
        runId: run.runId,
        client_request_id: `cancel-${broken}`,
      });
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.issue?.code, "invalid_definition");
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
        missing_prompt:
          "title: Missing prompt\ndescription: Invalid\nsteps:\n  - id: first\n    title: First\n",
      };
      for (const [name, content] of Object.entries(invalidFiles)) {
        yield* fs.writeFileString(filename(name), content);
      }
      const discovered = yield* store.discover(workspaceRoot);
      assert.deepStrictEqual(
        discovered.playbooks.map(({ name }) => name),
        ["demo", "duplicate", "empty", "malformed", "missing_prompt"],
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
      assert.deepStrictEqual(yield* store.discover(path.join(workspaceRoot, "empty-workspace")), {
        playbooks: [],
      });
      assert.equal(
        (yield* Effect.flip(store.start(owner, workspaceRoot, "../demo", "outside"))).code,
        "invalid_name",
      );
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
    assert.include(lastBoundary.message, "playbook_complete");
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
    const starts = yield* Effect.all(
      ["start-1", "start-2"].map((key) =>
        store.start(owner, workspaceRoot, "demo", key).pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    assert.equal(starts.filter(Result.isSuccess).length, 1);
    assert.deepStrictEqual(
      starts.filter(Result.isFailure).map(({ failure }) => failure.code),
      ["already_active"],
    );
    const run = yield* store.current(owner);
    const results = yield* Effect.all(
      ["next-1", "next-2"].map((key) =>
        store
          .mutate(owner, {
            operation: "next",
            runId: run.runId,
            expectedStepId: "research",
            client_request_id: key,
          })
          .pipe(Effect.result),
      ),
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
      const results = yield* Effect.all(
        ["one", "two"].map((key) =>
          store
            .mutate(owner, {
              operation,
              runId: run.runId,
              expectedStepId: "implement",
              client_request_id: `${operation}-${key}`,
            })
            .pipe(Effect.result),
        ),
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
          operation: "reselect",
          runId: run.runId,
          expectedStepId: "implement",
          stepId: "review",
          client_request_id: "foreign-reselect",
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
        assert.equal(current.currentStep?.prompt, "After restart: research");
        const retry = yield* store.mutate(owner, {
          operation: "next",
          runId,
          expectedStepId: "research",
          client_request_id: "next",
        });
        assert.isTrue(retry.replayed);
        assert.equal(retry.currentStepId, "research");
        assert.equal(retry.currentStep?.prompt, "After restart: research");
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

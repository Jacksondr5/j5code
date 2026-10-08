import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { formatRunFailureField, runFailureDetail } from "./runFailures.ts";
import { spawnMessageId, spawnThreadId } from "./spawnIds.ts";
import {
  SpawnWorkspaceService,
  layerFromReceiptStore,
  spawnCreateCommandId,
} from "./spawnWorkspace.ts";
import { makeHarness, modelSelection, projectId } from "../test-support/threadLaunchHarness.ts";

const stableInput = { providerSessionId: "provider-session:spawn", requestKey: "builder" };
const threadId = spawnThreadId(stableInput);
const squadronId = "squadron:spawn-workspace";

/** The J5 workspace service over a real orchestrator and ThreadLaunch, git and setup faked. */
const spawnLayer = (harness: ReturnType<typeof makeHarness>) =>
  Layer.mergeAll(
    layerFromReceiptStore.pipe(Layer.provide(Layer.mergeAll(harness.layer, harness.services))),
    harness.layer,
  );

/** What spawn_agent does for a worktree spawn once the thread's home is recorded. */
const startWorktreeSpawn = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: spawnCreateCommandId(stableInput, "worktree"),
    threadId,
    projectId,
    title: "Builder",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  yield* (yield* SpawnWorkspaceService).startBrief({
    workspace: { type: "worktree", baseRef: "main", startFromOrigin: false },
    stableInput,
    squadronId,
    projectId,
    threadId,
    title: "Builder",
    messageId: spawnMessageId(stableInput),
    text: "Build the fix and report back.",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
  });
});

/** An ordinary message to the spawn: from the person in the UI, or from another agent. */
const ordinaryMessage = (
  id: string,
  to: ThreadId,
  from: { readonly createdBy: "user" | "agent"; readonly creationSource: "web" | "mcp" },
) =>
  Effect.gen(function* () {
    return yield* (yield* ThreadManagementService).dispatch({
      type: "message.dispatch",
      ...from,
      commandId: CommandId.make(`command:ordinary:${id}`),
      threadId: to,
      messageId: MessageId.make(`message:ordinary:${id}`),
      text: "Carry on.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
    });
  });

const firstRunReaches = (id: ThreadId, statuses: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    yield* threads.streamStoredEventsFrom({ threadId: id }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" && statuses.has(stored.event.payload.status),
      ),
      Stream.runHead,
    );
    return yield* threads.getThreadProjection(id);
  });

it.effect("holds a worktree spawn's brief as preparing until ThreadLaunch releases it", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* startWorktreeSpawn;
    const projection = yield* firstRunReaches(threadId, new Set(["starting"]));
    assert.equal(projection.runs[0]?.status, "starting");
    assert.equal(projection.messages[0]?.id, spawnMessageId(stableInput));
    assert.equal(projection.messages[0]?.text, "Build the fix and report back.");
    // ThreadLaunch bound the thread to the worktree it made from the caller's branch.
    assert.equal(projection.thread.worktreePath, "/repo-worktrees/feature");
    assert.isNotNull(projection.thread.branch);
    assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.baseRefName, "main");
    // Once its worktree is bound, the peer takes ordinary messages again.
    yield* ordinaryMessage("bound", threadId, { createdBy: "user", creationSource: "web" });
  }).pipe(Effect.provide(spawnLayer(harness)));
});

it.effect("a message sent while the worktree is still being created waits for it", () =>
  Effect.gen(function* () {
    const checkoutStarted = yield* Deferred.make<void>();
    const finishCheckout = yield* Deferred.make<void>();
    const harness = makeHarness({
      createWorktree: (input) =>
        Deferred.succeed(checkoutStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishCheckout)),
          Effect.as({
            worktree: {
              path: "/repo-worktrees/feature",
              refName: input.newRefName,
              headSha: "abc",
            },
          } as never),
        ),
    });
    yield* Effect.gen(function* () {
      yield* startWorktreeSpawn;
      // The peer is registered with no worktree yet, its brief held as a preparing run.
      yield* Deferred.await(checkoutStarted);
      yield* ordinaryMessage("early", threadId, { createdBy: "agent", creationSource: "mcp" });
      const threads = yield* ThreadManagementService;
      const queued = yield* threads.getThreadProjection(threadId);
      assert.isNull(queued.thread.worktreePath);
      assert.lengthOf(queued.runs, 2);
      yield* Deferred.succeed(finishCheckout, undefined);
      const projection = yield* firstRunReaches(threadId, new Set(["starting"]));
      // Both turns belong to the thread that is now bound to its worktree.
      assert.equal(projection.thread.worktreePath, "/repo-worktrees/feature");
      assert.lengthOf(projection.runs, 2);
      assert.isFalse(projection.runs.some((run) => run.status === "failed"));
    }).pipe(Effect.provide(spawnLayer(harness)));
  }),
);

it.effect("a failed worktree preparation fails the brief with the detail Captains are told", () => {
  const harness = makeHarness({
    createWorktree: () => Effect.fail(new Error("worktree path is taken") as never),
  });
  return Effect.gen(function* () {
    yield* startWorktreeSpawn;
    const projection = yield* firstRunReaches(threadId, new Set(["failed"]));
    const run = projection.runs[0]!;
    assert.equal(run.status, "failed");
    assert.isNull(projection.thread.worktreePath);
    // The launch report and seat-finish notices read the failure through runFailureDetail.
    const failure = runFailureDetail(projection, run.id);
    assert.include(failure?.message, "worktree path is taken");
    assert.include(formatRunFailureField(failure), "worktree path is taken");
  }).pipe(Effect.provide(spawnLayer(harness)));
});

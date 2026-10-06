import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { A2AHomeNotFoundError, A2AHomeRegistrar, participantIdForThread } from "./HomeRegistrar.ts";
import { SquadronProjectReferences } from "./SquadronProjectReferences.ts";
import {
  SquadronThreadCreationService,
  layer as squadronThreadCreationLayer,
  type SquadronThreadCreationInput,
} from "./SquadronThreadCreationService.ts";
import { SquadronId } from "./contracts.ts";
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

/**
 * What spawn_agent does for a worktree spawn up to its wait: create the thread, read the event
 * sequence, start the brief. Returns the sequence, which `awaitWorkspaceReady` resumes from.
 */
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
  const afterSequence = yield* threads.getThreadEventSequence(threadId);
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
  return afterSequence;
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

/**
 * Watches the thread's stored events as `type[:status|:phase|:bound]` lines, in order. `reached`
 * completes once a line has been seen, so a test waits on the event, not on time.
 */
const watchEvents = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const seen: Array<string> = [];
  const waiting = new Map<string, Deferred.Deferred<void>>();
  const waiter = (label: string) => {
    const existing = waiting.get(label);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<void>();
    waiting.set(label, created);
    return created;
  };
  yield* threads.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
    Stream.runForEach(({ event }) => {
      const payload = event.payload as {
        readonly status?: string;
        readonly phase?: string;
        readonly worktreePath?: string | null;
      };
      const label = [
        event.type,
        payload.status ?? payload.phase ?? (payload.worktreePath ? "bound" : undefined),
      ]
        .filter((part) => part !== undefined)
        .join(":");
      seen.push(label);
      return Deferred.succeed(waiter(label), undefined);
    }),
    Effect.forkChild,
  );
  return { seen, reached: (label: string) => Deferred.await(waiter(label)) };
});

it.effect("returns once the checkout is bound, without waiting for the setup script", () => {
  const registrations: Array<SquadronThreadCreationInput> = [];
  return Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    // ThreadLaunch calls the real creation service; the home writes it would make are recorded.
    const homeWrites: Array<unknown> = [];
    const real = yield* SquadronThreadCreationService.pipe(
      Effect.provide(
        squadronThreadCreationLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(A2AHomeRegistrar)({
                registerAtCreation: (write) =>
                  Effect.sync(() => {
                    homeWrites.push(write);
                    return {
                      squadronId: SquadronId.make(squadronId),
                      participantId: participantIdForThread(threadId),
                    };
                  }),
                getHomeForThread: (id) => Effect.fail(new A2AHomeNotFoundError({ threadId: id })),
              }),
              Layer.mock(SquadronProjectReferences)({
                listForSquadron: () => Effect.succeed([]),
              }),
            ),
          ),
        ),
      ),
    );
    const harness = makeHarness({
      registerAtDurableLaunch: (input) => {
        registrations.push(input);
        return real.registerAtDurableLaunch(input);
      },
      // The project's setup script is held open: the checkout is long done, the script is not.
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({
            status: "started" as const,
            async: false,
            scriptId: "setup",
            scriptName: "Setup",
            scriptCommand: "vp install",
            terminalId: "setup",
            cwd: "/repo-worktrees/feature",
          }),
        ),
    });
    yield* Effect.gen(function* () {
      const watch = yield* watchEvents;
      const afterSequence = yield* startWorktreeSpawn;
      const readiness = yield* (yield* SpawnWorkspaceService).awaitWorkspaceReady({
        threadId,
        afterSequence,
      });
      assert.deepStrictEqual(readiness, { ready: true });
      // ThreadLaunch asked to register the peer, and nothing was written: the peer has no home,
      // so it cannot be addressed, until spawn_agent registers it after this returns.
      assert.lengthOf(registrations, 1);
      assert.lengthOf(homeWrites, 0);
      const threads = yield* ThreadManagementService;
      const bound = yield* threads.getThreadProjection(threadId);
      assert.equal(bound.thread.worktreePath, "/repo-worktrees/feature");
      // The brief is still held as a preparing run, so the agent has not begun.
      assert.equal(bound.runs[0]?.status, "preparing");
      // What the wait saw, in order: the run held, the binding, then the setup phase.
      yield* watch.reached("thread.metadata-updated:bound");
      const beforeSetup = [...watch.seen];
      assert.notInclude(beforeSetup.join(" "), "run.updated:starting");
      yield* Deferred.await(setupEntered);
      yield* Deferred.succeed(allowSetup, undefined);
      const released = yield* firstRunReaches(threadId, new Set(["starting"]));
      assert.equal(released.runs[0]?.status, "starting");
      yield* ordinaryMessage("bound", threadId, { createdBy: "user", creationSource: "web" });
      assert.deepStrictEqual(
        registrations.map((registration) => [registration.squadronId, registration.threadId]),
        [[squadronId, threadId]],
      );
      // The order the wait relied on: the brief is held, the checkout binds the thread, and only
      // after the held setup script was released does the agent's run start.
      const at = (label: string) => watch.seen.indexOf(label);
      assert.isTrue(at("run.created:preparing") >= 0);
      assert.isTrue(at("run.created:preparing") < at("thread.metadata-updated:bound"));
      assert.isTrue(at("thread.metadata-updated:bound") < at("run.updated:starting"));
    }).pipe(Effect.provide(spawnLayer(harness)));
  });
});

it.effect("a failed checkout is reported, and retiring the peer leaves nothing running", () => {
  const harness = makeHarness({
    createWorktree: () => Effect.fail(new Error("worktree path is taken") as never),
  });
  return Effect.gen(function* () {
    const watch = yield* watchEvents;
    const afterSequence = yield* startWorktreeSpawn;
    const service = yield* SpawnWorkspaceService;
    const readiness = yield* service.awaitWorkspaceReady({ threadId, afterSequence });
    assert.isFalse(readiness.ready);
    if (readiness.ready) return;
    assert.include(readiness.detail, "worktree path is taken");
    yield* service.retireUnready({ stableInput, threadId });
    const threads = yield* ThreadManagementService;
    const after = yield* threads.getThreadProjection(threadId);
    assert.isNotNull(after.thread.archivedAt);
    assert.isNull(after.thread.worktreePath);
    assert.deepStrictEqual(
      after.runs.map((run) => run.status),
      ["failed"],
    );
    // Upstream queues a message to an archived thread but never starts it, so nothing runs in
    // the project's checkout.
    yield* ordinaryMessage("late", threadId, { createdBy: "agent", creationSource: "mcp" });
    yield* Effect.yieldNow;
    assert.notInclude(watch.seen.join(" "), "run.updated:starting");
    assert.isNull((yield* threads.getThreadProjection(threadId)).thread.worktreePath);
  }).pipe(Effect.provide(spawnLayer(harness)));
});

it.effect("a message queued behind a failing checkout never runs in the project root", () =>
  Effect.gen(function* () {
    const checkoutStarted = yield* Deferred.make<void>();
    const failCheckout = yield* Deferred.make<void>();
    const harness = makeHarness({
      // The checkout hook is held, then fails: the reviewer's FIFO repro.
      createWorktree: () =>
        Deferred.succeed(checkoutStarted, undefined).pipe(
          Effect.andThen(Deferred.await(failCheckout)),
          Effect.andThen(Effect.fail(new Error("post-checkout hook exited 1") as never)),
        ),
    });
    yield* Effect.gen(function* () {
      const watch = yield* watchEvents;
      const afterSequence = yield* startWorktreeSpawn;
      yield* Deferred.await(checkoutStarted);
      const service = yield* SpawnWorkspaceService;
      const threads = yield* ThreadManagementService;
      // The parent's message lands while the checkout is held: it queues behind the brief.
      yield* ordinaryMessage("parent", threadId, { createdBy: "agent", creationSource: "mcp" });
      yield* Deferred.succeed(failCheckout, undefined);
      const readiness = yield* service.awaitWorkspaceReady({ threadId, afterSequence });
      assert.isFalse(readiness.ready);
      yield* service.retireUnready({ stableInput, threadId });
      const after = yield* threads.getThreadProjection(threadId);
      assert.isNull(after.thread.worktreePath);
      assert.isNotNull(after.thread.archivedAt);
      // The brief failed, the peer was archived, and the queued message was cancelled with it:
      // no run of this thread ever started.
      const at = (label: string) => watch.seen.indexOf(label);
      assert.isTrue(at("run.updated:failed") >= 0);
      assert.isTrue(at("run.updated:failed") < at("thread.archived"));
      assert.isTrue(at("thread.archived") < at("run.updated:cancelled"));
      assert.notInclude(watch.seen.join(" "), "run.updated:starting");
    }).pipe(Effect.provide(spawnLayer(harness)));
  }),
);

it.effect("a checkout still running after 60 seconds is stopped and the peer retired", () =>
  Effect.gen(function* () {
    const checkoutStarted = yield* Deferred.make<void>();
    const harness = makeHarness({
      // The checkout never finishes.
      createWorktree: () =>
        Deferred.succeed(checkoutStarted, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.gen(function* () {
      const watch = yield* watchEvents;
      const afterSequence = yield* startWorktreeSpawn;
      yield* Deferred.await(checkoutStarted);
      const service = yield* SpawnWorkspaceService;
      const waiting = yield* service
        .awaitWorkspaceReady({ threadId, afterSequence })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("59 seconds");
      assert.isUndefined(waiting.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const readiness = yield* Fiber.join(waiting);
      assert.deepStrictEqual(readiness, {
        ready: false,
        detail: "timed out waiting 60s for the checkout",
      });
      yield* service.retireUnready({ stableInput, threadId });
      yield* watch.reached("thread.archived");
      const after = yield* (yield* ThreadManagementService).getThreadProjection(threadId);
      assert.isNotNull(after.thread.archivedAt);
      assert.isNull(after.thread.worktreePath);
      // The stopped preparation failed the held brief before the thread was archived.
      assert.deepStrictEqual(
        after.runs.map((run) => run.status),
        ["failed"],
      );
      assert.notInclude(watch.seen.join(" "), "run.updated:starting");
    }).pipe(Effect.provide(spawnLayer(harness)));
  }),
);

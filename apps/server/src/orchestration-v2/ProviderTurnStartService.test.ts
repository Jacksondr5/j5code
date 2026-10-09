import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextHandoffId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CodexAppServerRequestError } from "effect-codex-app-server/errors";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { QueuedRunWatchdog } from "../j5/run-observability/QueuedRunWatchdog.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterEventStreamError,
  ProviderAdapterResumeThreadError,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

it("does not commit running state when inherited background routing cannot be read", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath: "/tmp/missing-provider-turn-start-worktree",
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, { exists: () => Effect.succeed(false) } as never),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees, createWorktree }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(projectionReadCount).toBe(2);
    expect(pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-turn-start-project" });
    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/tmp/provider-turn-start-project",
      refName: "feature/restore",
      path: "/tmp/missing-provider-turn-start-worktree",
    });
    expect(writeIfRunCurrent).not.toHaveBeenCalled();
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  /** Opens the session, then fails loading its provider thread. */
  readonly ensureThreadFailure?: unknown;
  /**
   * Resumes a thread that has a native ref: resume fails, the fresh-thread
   * fallback succeeds, then reading history for its handoff fails.
   */
  readonly historyReadFailureAfterFallback?: unknown;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  /** Loads the thread and starts the run, then fails every later state read. */
  readonly failReadsAfterRunning?: boolean;
}) {
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: { instanceId: newInstanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      branch: null,
      worktreePath: null,
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  if ("historyReadFailureAfterFallback" in input) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  const events: Array<OrchestrationV2DomainEvent> = [];
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const resumeFallbackSession = {
    driver: providerThread.driver,
    // J5: only a resume failure reporting the conversation gone falls back.
    resumeThread: () =>
      Effect.fail(
        new ProviderAdapterResumeThreadError({
          driver: providerThread.driver,
          providerSessionId,
          providerThreadId,
          cause: "native thread is gone",
          nativeThreadMissing: true,
        }),
      ),
    ensureThread: () => Effect.succeed(providerThread),
  };
  const open = vi.fn(() =>
    input.interruptOpen === true
      ? Effect.interrupt
      : "historyReadFailureAfterFallback" in input
        ? Effect.succeed(resumeFallbackSession as never)
        : "ensureThreadFailure" in input
          ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
          : "openFailure" in input
            ? Effect.sync(() => {
                if (input.interruptRunBeforeOpenFailure === true) interruptRun();
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProviderSessionManager.ProviderSessionOpenError({
                      instanceId: newInstanceId,
                      providerSessionId,
                      cause: input.openFailure,
                    }),
                  ),
                ),
              )
            : input.failReadsAfterRunning === true
              ? Effect.succeed({
                  driver: providerThread.driver,
                  providerSession: {
                    id: providerSessionId,
                    driver: providerThread.driver,
                    providerInstanceId: newInstanceId,
                    status: "ready",
                    cwd: "/tmp/native-account-command",
                    model: null,
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: now,
                    updatedAt: now,
                    lastError: null,
                  },
                  ensureThread: () => Effect.succeed(providerThread),
                } as never)
              : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (input: RunExecutionService.RunExecutionServiceV2StartRootRunInput) => Effect.Effect<void>
  >(() =>
    input.failReadsAfterRunning === true
      ? Effect.void
      : Effect.die("A local command must not start a native turn."),
  );
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true &&
    projection.runs.find((candidate) => candidate.id === runId)?.status === "running"
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? Effect.succeed(true)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const writeIfRunCurrent = vi.fn(({ events: incoming, activeAttemptId, expectedStatus }) =>
    "writeFailure" in input
      ? Effect.fail(
          new EventSink.EventSinkWriteError({
            eventCount: incoming.length,
            cause: input.writeFailure,
          }),
        )
      : Effect.sync(() => {
          const current = projection.runs.find((candidate) => candidate.id === runId);
          const committed =
            current !== undefined &&
            current.activeAttemptId === activeAttemptId &&
            current.status === expectedStatus;
          if (committed) {
            for (const event of incoming) {
              expect(isDomainEvent(event)).toBe(true);
              events.push(event);
              projection = ProjectionStore.applyToProjection(projection, event);
            }
          }
          return { committed, storedEvents: [] };
        }),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: () => Effect.die("history read must fail first"),
        }),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        FileSystem.layerNoop({}),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () =>
            Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getRuntimeRecoveryProjection: () =>
            Effect.as(failReadIfRunning, {
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getTurnStartHistory: () =>
            Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: input.historyReadFailureAfterFallback,
              }),
            ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );
  return {
    open,
    writeIfRunCurrent,
    startRootRun,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a session-open failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("fails a starting run when its last start attempt cannot load the thread", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("Pi RPC read failed: pi process exited with code 1."),
    });

    yield* harness.start;

    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: {
          class: "provider_error",
          message: "Pi RPC read failed: pi process exited with code 1.",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a thread-load failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a thread-load failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "keeps a store failure after the provider loaded the thread typed and retryable",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        historyReadFailureAfterFallback: new Error("database unavailable"),
      });

      const error = yield* harness.start.pipe(Effect.flip);

      // The provider succeeded; the failing stage is the projection read, so
      // the run is not failed as a provider error on the last attempt.
      expect(error._tag).toBe("ProviderTurnStartError");
      expect((error.cause as { _tag?: string } | undefined)?._tag).toBe("ProjectionStoreReadError");
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");
      expect(harness.events).toEqual([]);
    }),
);

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    // "false" would skip the provider turn or the terminal write and leave the
    // run active. A read failure must reach the caller instead.
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn!());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun!());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");
  }),
);

effectIt.effect("does not overwrite a run interrupted while its thread loads", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.projection().turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

effectIt.effect("persists a failed sign-out without starting a provider turn", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "/logout",
      logoutFailure: "Could not stop all sessions for this provider. Try again.",
    });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider sign-out failed",
        failure: {
          class: "permission_error",
          message: "Could not stop all sessions for this provider. Try again.",
        },
      },
    ]);
  }),
);

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}

// J5 native resume (FORK.md): a resume failure that is not "conversation gone"
// fails the run at once instead of being retried or replaced by a fresh session.
const CODEX_DRIVER = ProviderDriverKind.make("codex");

interface NativeResumeIds {
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
}

/** Builds the resume failure the Codex adapter raises when a thread/resume response fails schema decode. */
const makeCodexResumeSchemaFailure = Effect.fn("makeCodexResumeSchemaFailure")(function* (
  ids: NativeResumeIds,
) {
  const resumeResponse = Schema.Struct({
    thread: Schema.Struct({
      turns: Schema.Array(
        Schema.Struct({
          items: Schema.Array(
            Schema.Union([
              Schema.Struct({ id: Schema.String, type: Schema.Literal("userMessage") }),
              Schema.Struct({ id: Schema.String, type: Schema.Literal("agentMessage") }),
            ]),
          ),
        }),
      ),
    }),
  });
  const schemaError = yield* Schema.decodeUnknownEffect(resumeResponse)({
    thread: { turns: [{ items: [{ id: "call-1", type: "functionCallOutput" }] }] },
  }).pipe(Effect.flip, Effect.orDie);
  return new ProviderAdapterResumeThreadError({
    driver: CODEX_DRIVER,
    ...ids,
    cause: CodexAppServerRequestError.invalidPayload(
      "thread/resume",
      "decode-payload",
      schemaError,
    ),
  });
});

/**
 * Starts a run whose provider thread already has native history, against a
 * provider session whose resume outcome the test chooses. Every event the
 * start writes is applied to one projection, as the store would.
 */
function makeNativeResumeHarness(input: {
  readonly text?: string;
  readonly resumeThread: (
    ids: NativeResumeIds,
  ) => Effect.Effect<never, ProviderAdapterResumeThreadError>;
  readonly withoutNativeRef?: boolean;
  /** Handoffs already recorded for the run's provider thread. */
  readonly contextHandoffs?: (
    ids: NativeResumeIds & { readonly runId: RunId; readonly nativeThreadId: string },
  ) => ReadonlyArray<unknown>;
}) {
  const initial = makeLocalCommandHarness({
    text: input.text ?? "Continue",
    previousMessages: ["Existing native conversation"],
  }).projection();
  const run = initial.runs[0]!;
  const nativeThreadRef = {
    driver: CODEX_DRIVER,
    nativeId: "native-context-must-survive",
    strength: "strong" as const,
  };
  const providerThread = {
    ...initial.providerThreads[0]!,
    nativeThreadRef: input.withoutNativeRef === true ? null : nativeThreadRef,
    status: "idle" as const,
  };
  const ids = {
    providerSessionId: providerThread.providerSessionId!,
    providerThreadId: providerThread.id,
  };
  let projection: OrchestrationV2ThreadProjection = {
    ...initial,
    providerThreads: [providerThread],
    contextHandoffs: (input.contextHandoffs?.({
      ...ids,
      runId: run.id,
      nativeThreadId: nativeThreadRef.nativeId,
    }) ?? []) as unknown as OrchestrationV2ThreadProjection["contextHandoffs"],
  };
  const events: Array<OrchestrationV2DomainEvent> = [];
  const commit = (incoming: ReadonlyArray<OrchestrationV2DomainEvent>) => {
    for (const event of incoming) {
      events.push(event);
      projection = ProjectionStore.applyToProjection(projection, event);
    }
  };
  const resumeThread = vi.fn(() => input.resumeThread(ids));
  const ensureThread = vi.fn(
    (_load: { readonly existingProviderThread?: { readonly nativeThreadRef: unknown } }) =>
      Effect.succeed({
        ...providerThread,
        nativeThreadRef: { ...nativeThreadRef, nativeId: "native-replacement" },
      }),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const projectionRead = () =>
    Effect.sync(() => ({
      ...projection,
      hasConversation: projection.messages.some(
        (m) =>
          m.role === "user" &&
          (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
      ),
    }));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: (handoff) =>
            Effect.succeed({
              id: ContextHandoffId.make("handoff-native-resume-fallback"),
              transferId: handoff.transferId,
              threadId: handoff.threadId,
              targetRunId: handoff.targetRunId,
              fromProviderThreadIds: handoff.fromProviderThreadIds,
              toProviderThreadId: handoff.toProviderThreadId,
              coveredRunOrdinals: handoff.coveredRunOrdinals,
              strategy: handoff.strategy,
              status: "ready",
              summaryMessageId: null,
              summaryText: "summary",
              createdByProviderInstanceId: handoff.toProviderInstanceId,
              createdAt: handoff.createdAt,
            } as never),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events: incoming }) =>
            Effect.sync(() => {
              commit(incoming);
              return [] as never;
            }),
          writeIfRunCurrent: ({ events: incoming, activeAttemptId, expectedStatus }) =>
            Effect.sync(() => {
              const current = projection.runs.find((candidate) => candidate.id === run.id);
              const committed =
                current?.activeAttemptId === activeAttemptId && current.status === expectedStatus;
              if (committed) commit(incoming);
              return { committed, storedEvents: [] };
            }),
        }),
        IdAllocator.layer,
        FileSystem.layerNoop({}),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: projectionRead,
          getRuntimeRecoveryProjection: projectionRead,
          getTurnStartHistory: () => Effect.succeed([]),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              driver: CODEX_DRIVER,
              providerSession: {
                id: ids.providerSessionId,
                driver: CODEX_DRIVER,
                providerInstanceId: run.providerInstanceId,
                status: "ready",
                cwd: "/tmp/native-account-command",
                model: null,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: providerThread.createdAt,
                updatedAt: providerThread.updatedAt,
                lastError: null,
              },
              resumeThread,
              ensureThread,
            } as never),
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );
  return {
    ...ids,
    runId: run.id,
    nativeThreadRef,
    resumeThread,
    ensureThread,
    startRootRun,
    events,
    projection: () => projection,
    start: (options?: { readonly willRetry: boolean }) =>
      Effect.gen(function* () {
        yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
          threadId: projection.thread.id,
          runId: run.id,
          ...options,
        });
      }).pipe(Effect.provide(layer)),
  };
}

const failResume =
  (failure: (ids: NativeResumeIds) => Effect.Effect<ProviderAdapterResumeThreadError>) =>
  (ids: NativeResumeIds) =>
    failure(ids).pipe(Effect.flatMap(Effect.fail));

const nativeThreadGone = (ids: NativeResumeIds) =>
  Effect.fail(
    new ProviderAdapterResumeThreadError({
      driver: CODEX_DRIVER,
      ...ids,
      cause: new Error("thread not found: native-context-must-survive"),
      nativeThreadMissing: true,
    }),
  );

const freshConversationNotices = (projection: OrchestrationV2ThreadProjection) =>
  projection.turnItems.filter((item) => item.type === "system_notice");

effectIt.effect.each([
  {
    name: "a schema decode failure",
    failure: makeCodexResumeSchemaFailure,
    detail: [
      "ProviderAdapterResumeThreadError: Failed to resume codex provider thread",
      "[cause]: CodexAppServerRequestError: Invalid payload for method 'thread/resume' during 'decode-payload'",
      "[cause]: SchemaError: Expected",
    ],
  },
  {
    name: "a provider error that is not a missing conversation",
    failure: (ids: NativeResumeIds) =>
      Effect.succeed(
        new ProviderAdapterResumeThreadError({
          driver: CODEX_DRIVER,
          ...ids,
          cause: new Error("rollout file is locked by another process"),
          nativeThreadMissing: false,
        }),
      ),
    detail: ["[cause]: Error: rollout file is locked by another process"],
  },
])(
  "fails the run and keeps native history after $name, even when the start would be retried",
  ({ failure, detail }) =>
    Effect.gen(function* () {
      const harness = makeNativeResumeHarness({ resumeThread: failResume(failure) });

      // Returning normally is what stops the effect worker from retrying.
      yield* harness.start({ willRetry: true });

      expect(harness.ensureThread).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.providerThreads[0]?.nativeThreadRef).toEqual(harness.nativeThreadRef);
      expect(projection.contextTransfers).toEqual([]);
      expect(projection.contextHandoffs).toEqual([]);
      expect(projection.turnItems).toMatchObject([
        {
          type: "error",
          status: "failed",
          title: "Provider turn failed to start",
          failure: { class: "provider_error" },
        },
      ]);
      const item = projection.turnItems[0];
      const message = item?.type === "error" ? item.failure.message : "";
      expect(message).toContain(
        `Native codex provider resume failed for ${harness.providerThreadId}: `,
      );
      for (const line of detail) expect(message).toContain(line);
      // Schema paths stay; stack frames do not.
      expect(message).not.toMatch(/^\s+at (?!\[)/mu);
    }),
);

effectIt.effect.each(["Continue", "/compact"])(
  "fails %s once when native resume fails on the last start attempt",
  (text) =>
    Effect.gen(function* () {
      const harness = makeNativeResumeHarness({
        text,
        resumeThread: (ids) =>
          Effect.fail(
            new ProviderAdapterResumeThreadError({
              driver: CODEX_DRIVER,
              ...ids,
              cause: new Error("native resume rejected"),
            }),
          ),
      });

      yield* harness.start();
      yield* harness.start();

      expect(harness.ensureThread).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("failed");
      expect(projection.providerThreads[0]?.nativeThreadRef).toEqual(harness.nativeThreadRef);
      expect(
        harness.events.filter(
          (event) => event.type === "run.updated" && event.payload.status === "failed",
        ),
      ).toHaveLength(1);
      expect(projection.turnItems).toMatchObject([
        {
          type: "error",
          failure: { message: expect.stringContaining("native resume rejected") },
        },
      ]);
    }),
);

effectIt.effect("delivers no history after a terminal resume failure", () =>
  Effect.gen(function* () {
    const harness = makeNativeResumeHarness({
      resumeThread: failResume(makeCodexResumeSchemaFailure),
      contextHandoffs: ({ providerThreadId, runId }) => [
        {
          id: ContextHandoffId.make("handoff-ready-for-run"),
          toProviderThreadId: providerThreadId,
          targetRunId: runId,
          status: "ready",
        },
      ],
    });

    yield* harness.start({ willRetry: true });

    // A delivery attempt would persist a pending marker that later forces a new conversation.
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.events.filter((event) => event.type === "context-handoff.updated")).toEqual([]);
    expect(harness.projection().contextHandoffs).toMatchObject([{ status: "ready" }]);
  }),
);

effectIt.effect(
  "starts a new conversation with a visible notice when the provider no longer has it",
  () =>
    Effect.gen(function* () {
      const harness = makeNativeResumeHarness({ resumeThread: nativeThreadGone });

      yield* harness.start({ willRetry: true });

      expect(harness.ensureThread).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          existingProviderThread: expect.objectContaining({ nativeThreadRef: null }),
        }),
      );
      expect(harness.startRootRun).toHaveBeenCalledOnce();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("running");
      expect(projection.contextTransfers).toMatchObject([
        {
          type: "provider_handoff",
          targetRunId: harness.runId,
          status: "resolved_portable",
          resolution: { strategy: "portable_context" },
          error: expect.stringContaining("thread not found: native-context-must-survive"),
        },
      ]);
      expect(freshConversationNotices(projection)).toMatchObject([
        {
          runId: harness.runId,
          status: "completed",
          title: "Started a new provider conversation",
          message: expect.stringContaining("no longer has this conversation"),
        },
      ]);
    }),
);

effectIt.effect("starts a new conversation when an earlier history delivery is uncertain", () =>
  Effect.gen(function* () {
    const harness = makeNativeResumeHarness({
      resumeThread: () => Effect.die("An uncertain delivery must not resume native history"),
      contextHandoffs: ({ providerThreadId, nativeThreadId }) => [
        {
          id: ContextHandoffId.make("handoff-uncertain-delivery"),
          toProviderThreadId: providerThreadId,
          targetRunId: RunId.make("run-earlier"),
          status: "consumed",
          delivery: { nativeThreadId, status: "pending" },
        },
      ],
    });

    yield* harness.start();

    expect(harness.resumeThread).not.toHaveBeenCalled();
    expect(harness.ensureThread).toHaveBeenCalledOnce();
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(freshConversationNotices(harness.projection())).toMatchObject([
      { message: expect.stringContaining("earlier history handoff") },
    ]);
  }),
);

effectIt.effect("starts a thread without native history with no resume and no notice", () =>
  Effect.gen(function* () {
    const harness = makeNativeResumeHarness({
      withoutNativeRef: true,
      resumeThread: () => Effect.die("resumeThread must not run without a native ref"),
    });

    yield* harness.start();

    expect(harness.resumeThread).not.toHaveBeenCalled();
    expect(harness.ensureThread).toHaveBeenCalledOnce();
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(harness.projection().contextTransfers).toEqual([]);
    expect(freshConversationNotices(harness.projection())).toEqual([]);
  }),
);

effectIt.effect("reports a start failure to the run watchdog without replacing it", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });
    const recordVcsFailure = vi.fn(() => Effect.void);

    const error = yield* harness.startWithRetry.pipe(
      Effect.provideService(QueuedRunWatchdog, { scan: () => Effect.void, recordVcsFailure }),
      Effect.flip,
    );

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(recordVcsFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ phase: "start", cause: error }),
    );
  }),
);

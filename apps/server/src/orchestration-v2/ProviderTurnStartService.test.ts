import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextHandoffId,
  ContextTransferId,
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
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import { assertSupportedCodexCliVersion } from "../j5/codex/CodexCliVersionGate.ts";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterResumeThreadError,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { ProviderEventIngestorV2 } from "./ProviderEventIngestor.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ProviderAuthService } from "../provider/Services/ProviderAuthService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
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
        Layer.mock(ProviderAuthService)({ tryHandlePromptCommand: () => Effect.succeed(false) }),
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
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
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
  const events: Array<OrchestrationV2DomainEvent> = [];
  const open = vi.fn(() =>
    input.interruptOpen === true
      ? Effect.interrupt
      : "openFailure" in input
        ? Effect.sync(() => {
            if (input.interruptRunBeforeOpenFailure === true) {
              projection = {
                ...projection,
                runs: projection.runs.map((candidate) =>
                  candidate.id === runId
                    ? { ...candidate, status: "interrupted", completedAt: now }
                    : candidate,
                ),
              };
            }
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
        : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn(() => Effect.die("A local command must not start a native turn."));
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
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
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
            Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService)({ tryHandlePromptCommand }),
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

const resumeStartDependencies = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Layer.mock(GitWorkflow.GitWorkflowService)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProviderAuthService)({ tryHandlePromptCommand: () => Effect.succeed(false) }),
);

const CODEX_DRIVER = ProviderDriverKind.make("codex");

/** Serves the turn-start reads from one mutable projection. */
function startProjectionStore(current: () => OrchestrationV2ThreadProjection) {
  const withConversation = () =>
    Effect.sync(() => {
      const projection = current();
      return {
        ...projection,
        hasConversation: projection.messages.some(
          (m) =>
            m.role === "user" &&
            (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
        ),
      };
    });
  return Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getTurnStartContext: withConversation,
    getRuntimeRecoveryProjection: withConversation,
    getTurnStartHistory: () => Effect.succeed([]),
  });
}

/** Builds the resume failure the Codex adapter raises when a thread/resume response fails schema decode. */
const makeCodexResumeSchemaFailure = Effect.fn("makeCodexResumeSchemaFailure")(function* (input: {
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
}) {
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
  }).pipe(Effect.flip);
  return new ProviderAdapterResumeThreadError({
    driver: CODEX_DRIVER,
    providerSessionId: input.providerSessionId,
    providerThreadId: input.providerThreadId,
    cause: CodexAppServerRequestError.invalidPayload(
      "thread/resume",
      "decode-payload",
      schemaError,
    ),
  });
});

function makeResumeFallbackFixture(input: { readonly suffix: string }) {
  const threadId = ThreadId.make(`thread_resume_fallback_${input.suffix}`);
  const runId = RunId.make(`run_resume_fallback_${input.suffix}`);
  const attemptId = RunAttemptId.make(`attempt_resume_fallback_${input.suffix}`);
  const rootNodeId = NodeId.make(`node_resume_fallback_${input.suffix}`);
  const providerThreadId = ProviderThreadId.make(`provider_thread_resume_fallback_${input.suffix}`);
  const providerSessionId = ProviderSessionId.make(
    `provider_session_resume_fallback_${input.suffix}`,
  );
  const providerInstanceId = ProviderInstanceId.make("codex");
  const messageId = MessageId.make(`message_resume_fallback_${input.suffix}`);
  const checkpointScopeId = CheckpointScopeId.make(
    `checkpoint_scope_resume_fallback_${input.suffix}`,
  );
  const createdAt = DateTime.makeUnsafe("2026-09-03T00:00:00.000Z");
  const nativeThreadId = `codex:native-thread-${input.suffix}`;
  const providerThread = {
    id: providerThreadId,
    driver: CODEX_DRIVER,
    providerInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: CODEX_DRIVER, nativeId: nativeThreadId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
  };
  const projection = {
    thread: { id: threadId, branch: null, worktreePath: null },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        providerInstanceId,
        userMessageId: messageId,
        ordinal: 2,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.3-codex" },
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [providerThread],
    providerSessions: [],
    providerTurns: [],
    subagents: [],
    messages: [{ id: messageId, role: "user", text: "continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  return {
    threadId,
    runId,
    providerThreadId,
    providerSessionId,
    providerInstanceId,
    nativeThreadId,
    providerThread,
    projection,
  };
}

function makeLogCapture() {
  const records: Array<Record<string, unknown>> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    for (const entry of Array.isArray(message) ? message : [message]) {
      if (typeof entry === "object" && entry !== null) {
        records.push(entry as Record<string, unknown>);
      }
    }
  });
  return { records, layer: Logger.layer([logger], { mergeWithExisting: false }) };
}

/** Starts one run against a mocked provider session and records what it wrote. */
async function startWithResume(input: {
  readonly fixture: ReturnType<typeof makeResumeFallbackFixture>;
  readonly projection?: OrchestrationV2ThreadProjection;
  readonly resumeThread: () => Effect.Effect<never, unknown>;
  readonly ensureThread?: () => Effect.Effect<unknown, unknown>;
}) {
  const { fixture } = input;
  const projection = input.projection ?? fixture.projection;
  const written: Array<OrchestrationV2DomainEvent> = [];
  const write = vi.fn((write: { readonly events: ReadonlyArray<OrchestrationV2DomainEvent> }) => {
    written.push(...write.events);
    return Effect.succeed([] as never);
  });
  const logCapture = makeLogCapture();
  let startedSession: ProviderAdapterV2SessionRuntime | undefined;
  const startRootRun = vi.fn((run: { readonly session: ProviderAdapterV2SessionRuntime }) => {
    startedSession = run.session;
    return Effect.void;
  });
  const resumeThread = vi.fn(input.resumeThread);
  const ensureThread = vi.fn(
    input.ensureThread ??
      (() =>
        Effect.succeed({
          ...fixture.providerThread,
          nativeThreadRef: {
            driver: CODEX_DRIVER,
            nativeId: "codex:native-thread-replacement",
            strength: "strong",
          },
        })),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        resumeStartDependencies,
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: (handoff) =>
            Effect.succeed({
              id: ContextHandoffId.make(`handoff_resume_fallback_${fixture.runId}`),
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
          write,
          writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
        }),
        IdAllocator.layer,
        startProjectionStore(() => projection),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              driver: CODEX_DRIVER,
              providerSession: { id: fixture.providerSessionId },
              resumeThread,
              ensureThread,
            } as never),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun: startRootRun as never,
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  await Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
    service.start({ threadId: fixture.threadId, runId: fixture.runId }),
  ).pipe(Effect.provide(Layer.merge(layer, logCapture.layer)), Effect.runPromise);

  expect(startRootRun).toHaveBeenCalledTimes(1);
  return {
    written,
    logs: logCapture.records,
    resumeThread,
    ensureThread,
    session: startedSession!,
    startFailure: () => startedSession!.startTurn({} as never).pipe(Effect.flip, Effect.runPromise),
  };
}

const freshStartWarning = (written: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  written.flatMap((event) =>
    event.type === "turn-item.updated" && event.payload.type === "system_notice"
      ? [event.payload]
      : [],
  );

it.each([
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
    failure: (input: {
      readonly providerSessionId: ProviderSessionId;
      readonly providerThreadId: ProviderThreadId;
    }) =>
      Effect.succeed(
        new ProviderAdapterResumeThreadError({
          driver: CODEX_DRIVER,
          providerSessionId: input.providerSessionId,
          providerThreadId: input.providerThreadId,
          cause: new Error("rollout file is locked by another process"),
          nativeThreadMissing: false,
        }),
      ),
    detail: ["[cause]: Error: rollout file is locked by another process"],
  },
])("fails visibly and keeps native history after $name", async ({ failure, detail }) => {
  const fixture = makeResumeFallbackFixture({ suffix: "terminal" });
  const result = await startWithResume({
    fixture,
    resumeThread: () =>
      failure({
        providerSessionId: fixture.providerSessionId,
        providerThreadId: fixture.providerThreadId,
      }).pipe(Effect.flatMap(Effect.fail)),
  });

  expect(result.ensureThread).not.toHaveBeenCalled();
  expect(result.written).toEqual([]);
  const startFailure = await result.startFailure();
  expect(startFailure._tag).toBe("ProviderResumeFailedError");
  expect(startFailure.message).toContain(
    "Native codex provider resume failed for provider_thread_resume_fallback_terminal",
  );
  for (const line of detail) expect(startFailure.message).toContain(line);
  // Schema paths stay; stack frames do not.
  expect(startFailure.message).not.toMatch(/^\s+at (?!\[)/mu);
});

it("starts a new conversation with a visible warning when the provider no longer has it", async () => {
  const fixture = makeResumeFallbackFixture({ suffix: "missing" });
  const result = await startWithResume({
    fixture,
    resumeThread: () =>
      Effect.fail(
        new ProviderAdapterResumeThreadError({
          driver: CODEX_DRIVER,
          providerSessionId: fixture.providerSessionId,
          providerThreadId: fixture.providerThreadId,
          cause: new Error("thread not found: codex:native-thread-missing"),
          nativeThreadMissing: true,
        }),
      ),
  });

  expect(result.ensureThread).toHaveBeenCalledWith(
    expect.objectContaining({
      existingProviderThread: expect.objectContaining({ nativeThreadRef: null }),
    }),
  );
  const transfer = result.written.find((event) => event.type === "context-transfer.updated");
  expect(transfer?.type === "context-transfer.updated" && transfer.payload).toMatchObject({
    type: "provider_handoff",
    targetRunId: fixture.runId,
    status: "resolved_portable",
    resolution: { strategy: "portable_context" },
    error: expect.stringContaining("thread not found: codex:native-thread-missing"),
  });
  expect(freshStartWarning(result.written)).toEqual([
    expect.objectContaining({
      runId: fixture.runId,
      status: "completed",
      message: expect.stringContaining("no longer has this conversation"),
    }),
  ]);
  expect(result.logs).toContainEqual(
    expect.objectContaining({ runId: fixture.runId, reason: "native_thread_missing" }),
  );
  expect(result.session.startTurn).not.toBe(undefined);
});

it("starts a new conversation when an earlier history delivery is uncertain", async () => {
  const fixture = makeResumeFallbackFixture({ suffix: "uncertain" });
  const projection = {
    ...fixture.projection,
    contextHandoffs: [
      {
        id: ContextHandoffId.make("handoff_uncertain_delivery"),
        toProviderThreadId: fixture.providerThreadId,
        targetRunId: RunId.make("run_earlier"),
        status: "consumed",
        delivery: { nativeThreadId: fixture.nativeThreadId, status: "pending" },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const result = await startWithResume({
    fixture,
    projection,
    resumeThread: () => Effect.die("An uncertain delivery must not resume native history"),
  });

  expect(result.resumeThread).not.toHaveBeenCalled();
  expect(result.ensureThread).toHaveBeenCalledTimes(1);
  expect(freshStartWarning(result.written)).toEqual([
    expect.objectContaining({ message: expect.stringContaining("earlier history handoff") }),
  ]);
  expect(result.logs).toContainEqual(
    expect.objectContaining({ reason: "uncertain_history_delivery" }),
  );
});

it("delivers no history after a terminal resume failure", async () => {
  const fixture = makeResumeFallbackFixture({ suffix: "no_delivery" });
  const projection = {
    ...fixture.projection,
    contextHandoffs: [
      {
        id: ContextHandoffId.make("handoff_ready_for_run"),
        toProviderThreadId: fixture.providerThreadId,
        targetRunId: fixture.runId,
        status: "ready",
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const result = await startWithResume({
    fixture,
    projection,
    resumeThread: () =>
      makeCodexResumeSchemaFailure({
        providerSessionId: fixture.providerSessionId,
        providerThreadId: fixture.providerThreadId,
      }).pipe(Effect.flatMap(Effect.fail)),
  });

  // A delivery attempt would persist a pending marker that later forces a new conversation.
  expect((await result.startFailure())._tag).toBe("ProviderResumeFailedError");
  expect(result.written).toEqual([]);
});

it("keeps the no-native-ref fresh-start path unchanged", async () => {
  const fixture = makeResumeFallbackFixture({ suffix: "no_native_ref" });
  const providerThread = { ...fixture.providerThread, nativeThreadRef: null };
  const result = await startWithResume({
    fixture,
    projection: {
      ...fixture.projection,
      providerThreads: [providerThread],
    } as unknown as OrchestrationV2ThreadProjection,
    resumeThread: () => Effect.die("resumeThread must not run without a native ref"),
    ensureThread: () => Effect.succeed(providerThread),
  });

  expect(result.resumeThread).not.toHaveBeenCalled();
  expect(result.ensureThread).toHaveBeenCalledTimes(1);
  expect(freshStartWarning(result.written)).toEqual([]);
});

it("fails a fresh provider thread through run execution when the Codex CLI is unsupported", async () => {
  const fixture = makeResumeFallbackFixture({ suffix: "fresh_unsupported_cli" });
  const providerThread = { ...fixture.providerThread, nativeThreadRef: null };
  const result = await startWithResume({
    fixture,
    projection: {
      ...fixture.projection,
      providerThreads: [providerThread],
    } as unknown as OrchestrationV2ThreadProjection,
    resumeThread: () => Effect.die("resumeThread must not run without a native ref"),
    ensureThread: () =>
      assertSupportedCodexCliVersion("t3code_desktop/0.120.0 (Mac OS 26.4.1; arm64)").pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterEnsureThreadError({
              driver: CODEX_DRIVER,
              threadId: fixture.threadId,
              cause,
            }),
        ),
      ),
  });

  expect(result.resumeThread).not.toHaveBeenCalled();
  const startFailure = await result.startFailure();
  expect(startFailure._tag).toBe("ProviderAdapterProtocolError");
  expect(startFailure.message).toContain("J5 requires Codex CLI ≥ 0.151.0; found 0.120.0");
});

it("fails the run through run execution instead of falling back when the Codex CLI is unsupported", async () => {
  const fixture = makeResumeFallbackFixture({ suffix: "unsupported_cli" });
  const result = await startWithResume({
    fixture,
    resumeThread: () =>
      assertSupportedCodexCliVersion("t3code_desktop/0.120.0 (Mac OS 26.4.1; arm64)").pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterResumeThreadError({
              driver: CODEX_DRIVER,
              providerSessionId: fixture.providerSessionId,
              providerThreadId: fixture.providerThreadId,
              cause,
            }),
        ),
        Effect.andThen(Effect.die("unreachable")),
      ),
    ensureThread: () => Effect.die("ensureThread must not run for an unsupported CLI"),
  });

  expect(result.written).toEqual([]);
  const startFailure = await result.startFailure();
  expect(startFailure._tag).toBe("ProviderResumeFailedError");
  expect(startFailure.message).toContain("J5 requires Codex CLI ≥ 0.151.0; found 0.120.0");
});

for (const text of ["Continue", "/compact"]) {
  effectIt.effect(`terminalizes ${text} through run execution when native resume fails`, () =>
    Effect.gen(function* () {
      const initial = makeLocalCommandHarness({
        text,
        previousMessages: ["Existing native conversation"],
      }).projection();
      const run = initial.runs[0]!;
      const providerThread = {
        ...initial.providerThreads[0]!,
        nativeThreadRef: {
          driver: CODEX_DRIVER,
          nativeId: "native-context-must-survive",
          strength: "strong" as const,
        },
        status: "idle" as const,
      };
      let projection: OrchestrationV2ThreadProjection = {
        ...initial,
        providerThreads: [providerThread],
      };
      const providerSessionId = providerThread.providerSessionId!;
      const written: Array<OrchestrationV2DomainEvent> = [];
      const commitEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
        for (const event of events) {
          expect(isDomainEvent(event)).toBe(true);
          written.push(event);
          projection = ProjectionStore.applyToProjection(projection, event);
        }
      };
      const ensureThread = vi.fn(() =>
        Effect.die("A failed resume must not replace native history"),
      );
      const startTurn = vi.fn(() => Effect.die("A failed resume must not start a native turn"));
      const compactThread = vi.fn(() =>
        Effect.die("A failed resume must not compact native history"),
      );
      const runtime = {
        driver: CODEX_DRIVER,
        providerSession: {
          id: providerSessionId,
          driver: CODEX_DRIVER,
          providerInstanceId: run.providerInstanceId,
          status: "ready",
          cwd: "/tmp/native-account-command",
          model: run.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: providerThread.createdAt,
          updatedAt: providerThread.updatedAt,
          lastError: null,
        },
        events: Stream.never,
        resumeThread: () =>
          Effect.fail(
            new ProviderAdapterResumeThreadError({
              driver: CODEX_DRIVER,
              providerSessionId,
              providerThreadId: providerThread.id,
              cause: new Error("native resume rejected in integrated start proof"),
            }),
          ),
        ensureThread,
        startTurn,
        compactThread,
      } as unknown as ProviderAdapterV2SessionRuntime;
      const dependencies = Layer.mergeAll(
        resumeStartDependencies,
        IdAllocator.layer,
        ServerSettingsService.layerTest(),
        Layer.mock(CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
        Layer.mock(ProviderEventIngestorV2)({ ingestNormalized: () => Effect.succeed([]) }),
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: ({ events, activeAttemptId, expectedStatus }) =>
            Effect.sync(() => {
              const current = projection.runs.find((candidate) => candidate.id === run.id);
              const committed =
                current?.activeAttemptId === activeAttemptId && current.status === expectedStatus;
              if (committed) commitEvents(events);
              return { committed, storedEvents: [] };
            }),
          writeWithEffects: ({ events }) =>
            Effect.sync(() => {
              commitEvents(events);
              return [];
            }),
        }),
        startProjectionStore(() => projection),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () => Effect.succeed(runtime),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/tmp/native-account-command",
              approvalPolicy: "never",
              sandboxPolicy: { type: "dangerFullAccess" },
            }),
        }),
      );
      const layer = ProviderTurnStart.layer.pipe(
        Layer.provide(RunExecutionService.layer),
        Layer.provide(dependencies),
      );
      yield* Effect.gen(function* () {
        const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
        yield* service.start({ threadId: projection.thread.id, runId: run.id });
        yield* service.start({ threadId: projection.thread.id, runId: run.id });
      }).pipe(Effect.provide(layer));

      expect(ensureThread).not.toHaveBeenCalled();
      expect(startTurn).not.toHaveBeenCalled();
      expect(compactThread).not.toHaveBeenCalled();
      expect(projection.runs[0]?.status).toBe("failed");
      expect(projection.attempts[0]?.status).toBe("failed");
      expect(projection.nodes[0]?.status).toBe("failed");
      expect(projection.providerThreads[0]?.nativeThreadRef).toEqual(
        providerThread.nativeThreadRef,
      );
      expect(projection.contextTransfers).toEqual([]);
      expect(projection.contextHandoffs).toEqual([]);
      expect(
        written.filter(
          (event) => event.type === "run.updated" && event.payload.status === "failed",
        ),
      ).toHaveLength(1);
      expect(projection.turnItems).toEqual([
        expect.objectContaining({
          type: "error",
          status: "failed",
          failure: expect.objectContaining({
            message: expect.stringContaining("native resume rejected in integrated start proof"),
          }),
        }),
      ]);
    }),
  );
}

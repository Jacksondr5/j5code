import { expect, it, vi } from "vite-plus/test";
import {
  CheckpointScopeId,
  ContextHandoffId,
  ContextTransferId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import { assertSupportedCodexCliVersion } from "../j5/codex/CodexCliVersionGate.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterResumeThreadError,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

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
    thread: { id: threadId },
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
    messages: [{ id: messageId }],
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
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => {
            projectionReadCount += 1;
            return projectionReadCount === 1
              ? Effect.succeed(projection)
              : Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: "simulated inherited-background projection failure",
                  }),
                );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
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
    expect(writeIfRunCurrent).not.toHaveBeenCalled();
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

const CODEX_DRIVER = ProviderDriverKind.make("codex");

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

function makeResumeFallbackFixture(input: {
  readonly suffix: string;
  readonly existingFallbackTransferId?: ContextTransferId;
}) {
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
    thread: { id: threadId },
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
        modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [providerThread],
    providerSessions: [],
    messages: [{ id: messageId, text: "continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers:
      input.existingFallbackTransferId === undefined
        ? []
        : [
            {
              id: input.existingFallbackTransferId,
              type: "provider_handoff",
              sourceThreadId: threadId,
              targetThreadId: threadId,
              targetRunId: runId,
              status: "resolved_portable",
              resolution: {
                strategy: "portable_context",
                contextHandoffId: ContextHandoffId.make(`handoff_existing_${input.suffix}`),
              },
              error: "earlier failure",
            },
          ],
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

it("records the resume failure on the fallback transfer and warns with thread identifiers", async () => {
  const fixture = makeResumeFallbackFixture({ suffix: "recorded" });
  const written: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const write = vi.fn((input: { readonly events: ReadonlyArray<OrchestrationV2DomainEvent> }) => {
    written.push(input.events);
    return Effect.succeed([] as never);
  });
  const logCapture = makeLogCapture();
  const startRootRun = vi.fn(() => Effect.void);
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: (input) =>
            Effect.succeed({
              id: ContextHandoffId.make("handoff_resume_fallback_recorded"),
              transferId: input.transferId,
              threadId: input.threadId,
              targetRunId: input.targetRunId,
              fromProviderThreadIds: input.fromProviderThreadIds,
              toProviderThreadId: input.toProviderThreadId,
              coveredRunOrdinals: input.coveredRunOrdinals,
              strategy: input.strategy,
              status: "ready",
              summaryMessageId: null,
              summaryText: "summary",
              createdByProviderInstanceId: input.toProviderInstanceId,
              createdAt: input.createdAt,
            } as never),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write,
          writeIfRunCurrent: () => Effect.succeed({ committed: false, storedEvents: [] }),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(fixture.projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              driver: CODEX_DRIVER,
              providerSession: { id: fixture.providerSessionId },
              resumeThread: () =>
                makeCodexResumeSchemaFailure({
                  providerSessionId: fixture.providerSessionId,
                  providerThreadId: fixture.providerThreadId,
                }).pipe(Effect.flatMap(Effect.fail)),
              ensureThread: () =>
                Effect.succeed({
                  ...fixture.providerThread,
                  nativeThreadRef: {
                    driver: CODEX_DRIVER,
                    nativeId: "codex:native-thread-replacement",
                    strength: "strong",
                  },
                }),
            } as never),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  await Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
    service.start({ threadId: fixture.threadId, runId: fixture.runId }),
  ).pipe(Effect.provide(Layer.merge(layer, logCapture.layer)), Effect.runPromise);

  expect(write).toHaveBeenCalledTimes(1);
  const transferEvent = written.flat().find((event) => event.type === "context-transfer.updated");
  expect(transferEvent?.type).toBe("context-transfer.updated");
  if (transferEvent?.type !== "context-transfer.updated") return;
  expect(transferEvent.payload.status).toBe("resolved_portable");
  expect(transferEvent.payload.resolution?.strategy).toBe("portable_context");
  const error = transferEvent.payload.error;
  expect(typeof error).toBe("string");
  expect(error).toContain(
    "ProviderAdapterResumeThreadError: Failed to resume codex provider thread",
  );
  expect(error).toContain(
    "[cause]: CodexAppServerRequestError: Invalid payload for method 'thread/resume' during 'decode-payload'",
  );
  expect(error).toContain("[cause]: SchemaError: Expected");
  expect(error).toContain('at ["thread"]["turns"][0]["items"][0]');
  expect(error).not.toMatch(/^\s+at (?!\[)/mu);

  const warning = logCapture.records.find((record) => "nativeThreadId" in record);
  expect(warning).toMatchObject({
    threadId: fixture.threadId,
    providerThreadId: fixture.providerThreadId,
    nativeThreadId: fixture.nativeThreadId,
    runId: fixture.runId,
    error,
  });
  expect(startRootRun).not.toHaveBeenCalled();
});

it("warns instead of writing a second transfer when a resume fallback already exists", async () => {
  const existingTransferId = ContextTransferId.make("transfer_resume_fallback_existing");
  const fixture = makeResumeFallbackFixture({
    suffix: "existing",
    existingFallbackTransferId: existingTransferId,
  });
  const write = vi.fn(() => Effect.succeed([] as never));
  const logCapture = makeLogCapture();
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          write,
          writeIfRunCurrent: () => Effect.succeed({ committed: false, storedEvents: [] }),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(fixture.projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              driver: CODEX_DRIVER,
              providerSession: { id: fixture.providerSessionId },
              resumeThread: () =>
                makeCodexResumeSchemaFailure({
                  providerSessionId: fixture.providerSessionId,
                  providerThreadId: fixture.providerThreadId,
                }).pipe(Effect.flatMap(Effect.fail)),
              ensureThread: () => Effect.succeed(fixture.providerThread),
            } as never),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({}),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  await Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
    service.start({ threadId: fixture.threadId, runId: fixture.runId }),
  ).pipe(Effect.provide(Layer.merge(layer, logCapture.layer)), Effect.runPromise);

  expect(write).not.toHaveBeenCalled();
  const warnings = logCapture.records.filter((record) => "nativeThreadId" in record);
  expect(warnings).toHaveLength(2);
  expect(warnings[1]).toMatchObject({
    threadId: fixture.threadId,
    providerThreadId: fixture.providerThreadId,
    nativeThreadId: fixture.nativeThreadId,
    runId: fixture.runId,
    transferId: existingTransferId,
  });
  expect(typeof warnings[1]?.error).toBe("string");
});

it("fails the run through run execution instead of falling back when the Codex CLI is unsupported", async () => {
  const fixture = makeResumeFallbackFixture({ suffix: "unsupported_cli" });
  const write = vi.fn(() => Effect.succeed([] as never));
  const logCapture = makeLogCapture();
  let startedSession: ProviderAdapterV2SessionRuntime | undefined;
  const startRootRun = vi.fn((input: { readonly session: ProviderAdapterV2SessionRuntime }) => {
    startedSession = input.session;
    return Effect.void;
  });
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          write,
          writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.succeed({
              ...fixture.projection,
              providerTurns: [],
              subagents: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              driver: CODEX_DRIVER,
              providerSession: { id: fixture.providerSessionId },
              resumeThread: () =>
                assertSupportedCodexCliVersion(
                  "t3code_desktop/0.120.0 (Mac OS 26.4.1; arm64)",
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterResumeThreadError({
                        driver: CODEX_DRIVER,
                        providerSessionId: fixture.providerSessionId,
                        providerThreadId: fixture.providerThreadId,
                        cause,
                      }),
                  ),
                ),
              ensureThread: () => Effect.die("ensureThread must not run for an unsupported CLI"),
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

  expect(write).not.toHaveBeenCalled();
  expect(logCapture.records.filter((record) => "nativeThreadId" in record)).toHaveLength(0);
  expect(startRootRun).toHaveBeenCalledTimes(1);
  expect(startedSession).toBeDefined();
  const startFailure = await startedSession!
    .startTurn({} as never)
    .pipe(Effect.flip, Effect.runPromise);
  expect(startFailure._tag).toBe("ProviderAdapterProtocolError");
  expect(startFailure.message).toContain("J5 requires Codex CLI ≥ 0.151.0; found 0.120.0");
});

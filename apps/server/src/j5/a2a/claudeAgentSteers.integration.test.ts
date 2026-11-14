import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";

// Case 89 through the real Claude adapter and orchestrator, with a scripted Claude Code stream.

const sessionId = "agent-steer-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

const frame = (value: unknown) => value as SDKMessage;
const assistant = (uuid: string, content: ReadonlyArray<unknown>) =>
  frame({
    type: "assistant",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `message-${uuid}`,
      role: "assistant",
      type: "message",
      model: modelSelection.model,
      content,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
const build = assistant("build-call", [
  { type: "tool_use", id: "build", name: "Bash", input: { command: "make" } },
]);
const buildResult = frame({
  type: "user",
  uuid: "build-result",
  session_id: sessionId,
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "build", is_error: false, content: "build OK" }],
  },
});
const result = (uuid: string) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });
const turnStart = frame({ type: "system", subtype: "init", uuid: "init", session_id: sessionId });
const lifecycle = (commandUuid: string, state: string) =>
  frame({
    type: "command_lifecycle",
    command_uuid: commandUuid,
    state,
    uuid: `lifecycle-${state}-${commandUuid}`,
    session_id: sessionId,
  });

it.effect.each([
  { case: "an agent's steer joins the turn at the next tool result", steer: "agent-mid" },
  {
    case: "an agent's late steer gets the run of the turn Claude starts for it",
    steer: "agent-late",
  },
  { case: "a person's steer still uses now", steer: "person" },
] as const)("$case", ({ steer }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("j5-claude-agent-steers");
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const offers: SDKUserMessage[] = [];
      let interrupts = 0;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const random = yield* SecureRandom.SecureRandom;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      // Built in the harness so the adapter and the continuation worker share one request queue.
      const makeAdapter = Effect.gen(function* () {
        const continuationRequests =
          yield* ProviderContinuationRequests.ProviderContinuationRequests;
        return yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: modelSelection.instanceId,
          settings,
          environment: {},
          attachmentsDir: cwd,
          fileSystem,
          path,
          random,
          idAllocator,
          continuationRequests,
          queryRunner: {
            allocateSessionId: Effect.succeed(sessionId),
            open: () =>
              Effect.succeed({
                messages: Stream.fromQueue(sdkMessages),
                offer: (message) => Effect.sync(() => void offers.push(message)),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                stopTask: () => Effect.void,
                interrupt: Effect.sync(() => void interrupts++),
                close: Queue.shutdown(sdkMessages),
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:j5-agent-steer");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:j5-agent-steer"),
          title: "Agent steer",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("first"),
          text: "Run the build.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const building = yield* watch(
          (event) =>
            event.type === "turn-item.updated" && event.payload.nativeItemRef?.nativeId === "build",
        );
        yield* Queue.offer(sdkMessages, build);
        yield* Fiber.join(building);
        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("steer"),
          text: "Also update the changelog.",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: parent.id },
          createdBy: steer === "person" ? "user" : "agent",
          creationSource: steer === "person" ? "web" : "server",
        });
        yield* worker.drain();
        assert.lengthOf(offers, 2);
        const offered = offers[1]!;
        if (steer === "person") {
          assert.equal(offered.priority, "now");
          assert.isUndefined(offered.uuid);
          return;
        }
        assert.equal(offered.priority, "next");
        const steerUuid = offered.uuid ?? assert.fail("An agent's steer has a uuid.");

        const finished = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === parent.id &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(sdkMessages, lifecycle(steerUuid, "queued"));
        if (steer === "agent-mid") {
          yield* Queue.offer(sdkMessages, lifecycle(steerUuid, "started"));
          yield* Queue.offer(sdkMessages, buildResult);
        } else {
          const steerRun = yield* watch(
            (event) =>
              event.type === "run.created" &&
              event.payload.userMessageId === MessageId.make("steer"),
          );
          // The reply is written before Claude Code takes the steer, so the turn ends on it.
          yield* Queue.offer(sdkMessages, buildResult);
          yield* Queue.offer(
            sdkMessages,
            assistant("reply", [{ type: "text", text: "The build passed." }]),
          );
          yield* Queue.offer(sdkMessages, result("first-segment"));
          yield* Fiber.join(finished);
          // A person switches the thread's model before Claude Code starts the steer's turn.
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("switch"),
            threadId,
            modelSelection: { ...modelSelection, model: "claude-opus-4-6" },
          });
          yield* Queue.offer(sdkMessages, lifecycle(steerUuid, "started"));
          yield* Queue.offer(sdkMessages, turnStart);
          yield* Fiber.join(steerRun);
          yield* worker.drain();
        }
        const steerFinished = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.userMessageId ===
              MessageId.make(steer === "agent-late" ? "steer" : "first") &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(
          sdkMessages,
          assistant("changelog", [{ type: "text", text: "Updated the changelog too." }]),
        );
        yield* Queue.offer(sdkMessages, result("last-segment"));
        yield* Fiber.join(steer === "agent-late" ? steerFinished : finished);
        yield* worker.drain();

        const after = yield* orchestrator.getThreadProjection(threadId);
        // Claude Code already holds the steer, so its own run sends no prompt.
        assert.lengthOf(offers, 2);
        if (steer === "agent-late") {
          assert.deepEqual(
            after.runs.map((run) => [run.userMessageId, run.status]),
            [
              [MessageId.make("first"), "completed"],
              [MessageId.make("steer"), "completed"],
            ],
          );
          const replies = (runId: string) =>
            after.turnItems
              .filter((item) => item.runId === runId && item.type === "assistant_message")
              .map((item) => (item.type === "assistant_message" ? item.text : null));
          assert.deepEqual(replies(parent.id), ["The build passed."]);
          // The steer's run is the Claude turn already running, on the model it was steered into.
          assert.deepEqual(after.runs[1]!.modelSelection, parent.modelSelection);
          assert.deepEqual(replies(after.runs[1]!.id), ["Updated the changelog too."]);
          assert.isTrue(
            after.turnItems.some(
              (item) =>
                item.type === "user_message" &&
                item.messageId === MessageId.make("steer") &&
                item.runId === after.runs[1]!.id,
            ),
          );
          assert.equal(interrupts, 0);
          return;
        }
        assert.lengthOf(after.runs, 1);
        const buildItem = after.turnItems.find((item) => item.nativeItemRef?.nativeId === "build");
        assert.equal(buildItem?.status, "completed");
        assert.isTrue(
          after.turnItems.some(
            (item) =>
              item.runId === parent.id &&
              item.type === "assistant_message" &&
              item.text === "Updated the changelog too.",
          ),
        );
        assert.equal(interrupts, 0);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "j5-claude-agent-steers" },
            Layer.unwrap(
              Effect.map(
                makeAdapter.pipe(Effect.provide(NodeServices.layer)),
                ProviderAdapterRegistry.layerSingle,
              ),
            ),
            { runEffectWorker: false, runContinuationWorker: true },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  ),
);

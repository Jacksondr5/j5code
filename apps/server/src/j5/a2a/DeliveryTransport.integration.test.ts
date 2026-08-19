import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../../mcp/McpSessionRegistry.testkit.ts";
import { OrchestrationEffectWorkerV2 } from "../../orchestration-v2/EffectWorker.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2SteerInput,
} from "../../orchestration-v2/ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
} from "../../orchestration-v2/runtimeLayer.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  latestSteerableRun,
  ThreadManagementService,
  type ThreadManagementSendMode,
} from "../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  A2ADeliveryTransport,
  deliveryMessageId,
  live as deliveryTransportLayer,
} from "./DeliveryTransport.ts";
import { formatHumanEnvelope, formatPeerEnvelope } from "./EnvelopeFormatter.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import {
  CommCommandId,
  EpicId,
  ExchangeId,
  GLOBAL_HUMAN_PARTICIPANT_ID,
  LedgerMessageId,
  ParticipantId,
} from "./contracts.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-j5-a2a-delivery-transport-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const vcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(serverConfigLayer),
  Layer.provide(NodeServices.layer),
);

const checkpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(vcsDriverRegistryTestLayer),
);

const driver = ProviderDriverKind.make("codex");

interface DeliveryInvocation {
  readonly messageId: MessageId;
  readonly mode: ThreadManagementSendMode;
  readonly createdBy: "user" | "agent" | "system";
}

interface DeliveryHarness {
  readonly deliveryInvocations: Ref.Ref<ReadonlyArray<DeliveryInvocation>>;
  readonly steerInputs: Ref.Ref<ReadonlyArray<ProviderAdapterV2SteerInput>>;
}

const makeOrchestrationAdapter = (
  steerInputs: Ref.Ref<ReadonlyArray<ProviderAdapterV2SteerInput>>,
): ProviderAdapterV2Shape => ({
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (sessionInput) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      const providerSession: OrchestrationV2ProviderSession = {
        id: sessionInput.providerSessionId,
        driver,
        providerInstanceId: modelSelection.instanceId,
        status: "ready",
        cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
        model: sessionInput.modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };

      return {
        instanceId: modelSelection.instanceId,
        driver,
        providerSessionId: sessionInput.providerSessionId,
        providerSession,
        events: Stream.fromPubSub(events),
        ensureThread: (input) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            return {
              id: ProviderThreadId.make(`provider-thread:${input.threadId}`),
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `native-thread:${input.threadId}`,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            } satisfies OrchestrationV2ProviderThread;
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: (input) =>
          Effect.gen(function* () {
            const startedAt = yield* DateTime.now;
            yield* PubSub.publish(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: ProviderTurnId.make(`provider-turn:${input.attemptId}`),
                providerThreadId: input.providerThread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native-turn:${input.attemptId}`,
                  strength: "strong",
                },
                ordinal: input.providerTurnOrdinal,
                status: "running",
                startedAt,
                completedAt: null,
              },
            });
          }),
        steerTurn: (input) => Ref.update(steerInputs, (existing) => [...existing, input]),
        interruptTurn: () => Effect.die("interruptTurn is unused by the A2 delivery seam test"),
        respondToRuntimeRequest: () =>
          Effect.die("respondToRuntimeRequest is unused by the A2 delivery seam test"),
        readThreadSnapshot: () =>
          Effect.die("readThreadSnapshot is unused by the A2 delivery seam test"),
        rollbackThread: () => Effect.die("rollbackThread is unused by the A2 delivery seam test"),
        forkThread: () => Effect.die("forkThread is unused by the A2 delivery seam test"),
      };
    }),
});

const makeTestLayer = (harness: DeliveryHarness) => {
  const orchestrationAdapter = makeOrchestrationAdapter(harness.steerInputs);
  const providerInstance = {
    instanceId: modelSelection.instanceId,
    driverKind: driver,
    continuationIdentity: {
      driverKind: driver,
      continuationKey: "codex:j5-a2a-delivery-test",
    },
    displayName: "Codex A2 delivery test",
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  } satisfies ProviderInstance;
  const providerInstanceRegistryTestLayer = Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  const orchestrationTestLayer = Layer.merge(
    OrchestrationV2LayerLive,
    OrchestrationV2EventSinkLayerLive,
  ).pipe(
    Layer.provide(mcpSessionRegistryTestLayer),
    Layer.provide(checkpointStoreTestLayer),
    Layer.provide(serverConfigLayer),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(providerInstanceRegistryTestLayer),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const recordingThreadManagement = Layer.effect(
    ThreadManagementService,
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      return ThreadManagementService.of({
        ...threads,
        sendToThread: (input) =>
          Ref.update(harness.deliveryInvocations, (existing) => [
            ...existing,
            { messageId: input.messageId, mode: input.mode, createdBy: input.createdBy },
          ]).pipe(Effect.andThen(threads.sendToThread(input))),
      });
    }),
  );
  const recordedDeliveryTransport = deliveryTransportLayer.pipe(
    Layer.provide(recordingThreadManagement),
  );

  return Layer.merge(ledgerLayer, recordedDeliveryTransport).pipe(
    Layer.provideMerge(orchestrationTestLayer),
  );
};

const makeHarness = Effect.gen(function* () {
  return {
    deliveryInvocations: yield* Ref.make<ReadonlyArray<DeliveryInvocation>>([]),
    steerInputs: yield* Ref.make<ReadonlyArray<ProviderAdapterV2SteerInput>>([]),
  } satisfies DeliveryHarness;
});

const seedTarget = (suffix: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const ledger = yield* A2ALedger;
    const threadId = ThreadId.make(`thread:j5-a2a-delivery-${suffix}`);
    const projectId = ProjectId.make(`project:j5-a2a-delivery-${suffix}`);
    const epicId = EpicId.make(`epic:j5-a2a-delivery-${suffix}`);
    const senderId = ParticipantId.make(`agent:j5-a2a-delivery-${suffix}-sender`);
    const receiverId = ParticipantId.make(`agent:j5-a2a-delivery-${suffix}-receiver`);
    const exchangeId = ExchangeId.make(`exchange:j5-a2a-delivery-${suffix}`);
    const messageId = LedgerMessageId.make(`message:j5-a2a-delivery-${suffix}`);
    const createdAt = "2026-08-17T12:00:00.000Z";
    const message = `Reply through the real ${suffix} delivery seam.`;

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:j5-a2a-delivery-${suffix}-create-thread`),
      threadId,
      projectId,
      title: `J5 A2A ${suffix} delivery target`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: `/tmp/j5-a2a-delivery-${suffix}`,
    });
    yield* ledger.createEpic({
      epic: { id: epicId, name: `J5 A2A ${suffix} delivery`, createdAt },
    });
    yield* ledger.appendEvents({
      commandId: CommCommandId.make(`command:j5-a2a-delivery-${suffix}-join-target`),
      epicId,
      acceptedAt: createdAt,
      events: [
        {
          kind: "participant.joined",
          sender: null,
          receiver: receiverId,
          exchangeId: null,
          correlationId: null,
          payload: {
            participant: { kind: "agent", id: receiverId, threadId },
          },
          createdAt,
        },
      ],
    });

    return {
      threadId,
      projectId,
      epicId,
      senderId,
      receiverId,
      exchangeId,
      messageId,
      message,
      delivery: {
        originEpicId: epicId,
        receiverEpicId: epicId,
        messageId,
        senderId,
        receiverId,
        exchangeId,
        message,
      },
    };
  });

it.effect("starts an idle recipient immediately without the implicit auto mode", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const transport = yield* A2ADeliveryTransport;
      const target = yield* seedTarget("idle");

      yield* transport.deliverAgent(target.delivery);
      yield* transport.deliverAgent(target.delivery);

      const projection = yield* threads.getThreadProjection(target.threadId);
      const upstreamMessageId = deliveryMessageId(target.messageId);
      const deliveredMessages = projection.messages.filter(
        (candidate) => candidate.id === upstreamMessageId,
      );
      assert.lengthOf(deliveredMessages, 1);
      assert.equal(
        deliveredMessages[0]?.text,
        formatPeerEnvelope({
          senderId: target.senderId,
          originEpicId: target.epicId,
          exchangeId: target.exchangeId,
          message: target.message,
        }),
      );
      assert.lengthOf(projection.runs, 1);
      assert.equal(
        projection.turnItems.find(
          (
            candidate,
          ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
            candidate.type === "user_message" && candidate.messageId === upstreamMessageId,
        )?.inputIntent,
        "turn_start",
      );
      assert.deepStrictEqual(
        (yield* Ref.get(harness.deliveryInvocations))
          .filter((invocation) => invocation.messageId === upstreamMessageId)
          .map((invocation) => invocation.mode),
        ["queue", "queue"],
      );
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect("steers a busy recipient inside its active turn without queueing a later run", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      const threads = yield* ThreadManagementService;
      const transport = yield* A2ADeliveryTransport;
      const target = yield* seedTarget("busy");
      const active = yield* threads.sendToThread({
        projectId: target.projectId,
        commandId: CommandId.make("command:j5-a2a-delivery-busy-start"),
        threadId: target.threadId,
        messageId: MessageId.make("message:j5-a2a-delivery-busy-start"),
        text: "Stay active until the peer message arrives.",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(active.delivery, "started");

      const runningEvent = yield* eventSink.stream({ threadId: target.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "provider-turn.updated" &&
            stored.event.payload.status === "running",
        ),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      assert.isTrue(yield* worker.runOnce);
      yield* Fiber.join(runningEvent);
      const busyProjection = yield* threads.getThreadProjection(target.threadId);
      assert.equal(latestSteerableRun(busyProjection)?.id, active.run.id);

      yield* transport.deliverAgent(target.delivery);
      yield* transport.deliverAgent(target.delivery);
      assert.isTrue(yield* worker.runOnce);

      const upstreamMessageId = deliveryMessageId(target.messageId);
      const projection = yield* threads.getThreadProjection(target.threadId);
      const deliveredMessages = projection.messages.filter(
        (candidate) => candidate.id === upstreamMessageId,
      );
      assert.lengthOf(deliveredMessages, 1);
      assert.equal(deliveredMessages[0]?.runId, active.run.id);
      assert.equal(
        deliveredMessages[0]?.text,
        formatPeerEnvelope({
          senderId: target.senderId,
          originEpicId: target.epicId,
          exchangeId: target.exchangeId,
          message: target.message,
        }),
      );
      assert.lengthOf(projection.runs, 1);
      assert.equal(
        projection.turnItems.find(
          (
            candidate,
          ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
            candidate.type === "user_message" && candidate.messageId === upstreamMessageId,
        )?.inputIntent,
        "steer",
      );
      assert.deepStrictEqual(
        (yield* Ref.get(harness.deliveryInvocations))
          .filter((invocation) => invocation.messageId === upstreamMessageId)
          .map((invocation) => invocation.mode),
        ["steer", "steer"],
      );
      const steerInputs = yield* Ref.get(harness.steerInputs);
      assert.lengthOf(steerInputs, 1);
      assert.equal(steerInputs[0]?.runId, active.run.id);
      assert.equal(steerInputs[0]?.message.text, deliveredMessages[0]?.text);
      assert.isFalse(yield* worker.runOnce);
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

it.effect("attributes human-origin delivery to the user actor", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const transport = yield* A2ADeliveryTransport;
      const target = yield* seedTarget("human-origin");
      const humanMessageId = LedgerMessageId.make("message:j5-a2a-delivery-human-origin");
      const message = "Human-authored request delivered through A2A.";

      yield* transport.deliverAgent({
        ...target.delivery,
        messageId: humanMessageId,
        senderId: GLOBAL_HUMAN_PARTICIPANT_ID,
        message,
      });

      const upstreamMessageId = deliveryMessageId(humanMessageId);
      const projection = yield* threads.getThreadProjection(target.threadId);
      const delivered = projection.messages.find((candidate) => candidate.id === upstreamMessageId);
      assert.equal(delivered?.createdBy, "user");
      assert.equal(
        delivered?.text,
        formatHumanEnvelope({
          senderId: GLOBAL_HUMAN_PARTICIPANT_ID,
          exchangeId: target.exchangeId,
          message,
        }),
      );
      assert.deepStrictEqual(
        (yield* Ref.get(harness.deliveryInvocations)).filter(
          (invocation) => invocation.messageId === upstreamMessageId,
        ),
        [{ messageId: upstreamMessageId, mode: "queue", createdBy: "user" }],
      );
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

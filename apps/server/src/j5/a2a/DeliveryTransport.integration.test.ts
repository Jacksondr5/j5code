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
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
import {
  ThreadLifecycleService,
  layer as threadLifecycleServiceLayer,
} from "../../orchestration-v2/ThreadLifecycleService.ts";
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
import { manualLayer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { formatHumanEnvelope, formatPeerEnvelope } from "./EnvelopeFormatter.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { A2ALifecycleService, manualLayer as lifecycleServiceLayer } from "./LifecycleService.ts";
import { A2ASenderRetiredError, A2ASendService, layer as sendServiceLayer } from "./SendService.ts";
import {
  CommCommandId,
  SquadronId,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  type AgentParticipant,
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

const makeLifecycleTestLayer = (harness: DeliveryHarness) => {
  const base = makeTestLayer(harness);
  const send = sendServiceLayer.pipe(Layer.provide(base));
  const worker = deliveryWorkerLayer.pipe(Layer.provide(base));
  const lifecycle = lifecycleServiceLayer.pipe(Layer.provide(worker), Layer.provide(base));
  const threadLifecycle = threadLifecycleServiceLayer.pipe(Layer.provide(base));
  return Layer.mergeAll(base, send, worker, lifecycle, threadLifecycle);
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
    const squadronId = SquadronId.make(`squadron:j5-a2a-delivery-${suffix}`);
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
    yield* ledger.createSquadron({
      squadron: { id: squadronId, name: `J5 A2A ${suffix} delivery`, createdAt },
    });
    yield* ledger.appendEvents({
      commandId: CommCommandId.make(`command:j5-a2a-delivery-${suffix}-join-target`),
      squadronId,
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
      squadronId,
      senderId,
      receiverId,
      exchangeId,
      messageId,
      message,
      delivery: {
        originSquadronId: squadronId,
        receiverSquadronId: squadronId,
        messageId,
        senderId,
        receiverId,
        exchangeId,
        exchangeRole: "ask" as const,
        message,
        envelopeChannel: "peer" as const,
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
          originSquadronId: target.squadronId,
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
          originSquadronId: target.squadronId,
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
      const personId = ParticipantId.make("human:transport-person");
      const message = "Human-authored request delivered through A2A.";

      yield* transport.deliverAgent({
        ...target.delivery,
        messageId: humanMessageId,
        senderId: personId,
        message,
      });

      const upstreamMessageId = deliveryMessageId(humanMessageId);
      const projection = yield* threads.getThreadProjection(target.threadId);
      const delivered = projection.messages.find((candidate) => candidate.id === upstreamMessageId);
      assert.equal(delivered?.createdBy, "user");
      assert.equal(
        delivered?.text,
        formatHumanEnvelope({
          senderId: personId,
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

it.effect("routes real archive and delete commands through lifecycle closure exactly once", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threads = yield* ThreadManagementService;
      const threadLifecycle = yield* ThreadLifecycleService;
      const ledger = yield* A2ALedger;
      const send = yield* A2ASendService;
      const lifecycle = yield* A2ALifecycleService;
      const sql = yield* SqlClient.SqlClient;
      const squadronId = SquadronId.make("squadron:j5-a2a-lifecycle-command-path");
      const sender: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:j5-a2a-lifecycle-command-path-sender"),
        threadId: ThreadId.make("thread:j5-a2a-lifecycle-command-path-sender"),
      };
      const receiver: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:j5-a2a-lifecycle-command-path-receiver"),
        threadId: ThreadId.make("thread:j5-a2a-lifecycle-command-path-receiver"),
      };
      const createdAt = "2026-08-29T14:00:00.000Z";

      for (const [index, participant] of [sender, receiver].entries()) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:j5-a2a-lifecycle-command-path-create:${index}`),
          threadId: participant.threadId,
          projectId: ProjectId.make(`project:j5-a2a-lifecycle-command-path:${index}`),
          title: `J5 A2A lifecycle command path ${index}`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
      }
      yield* ledger.createSquadron({
        squadron: { id: squadronId, name: "Lifecycle command path", createdAt },
      });
      for (const [index, participant] of [sender, receiver].entries()) {
        yield* ledger.append({
          commandId: CommCommandId.make(`command:j5-a2a-lifecycle-command-path-join:${index}`),
          squadronId,
          acceptedAt: createdAt,
          event: {
            kind: "participant.joined",
            sender: null,
            receiver: participant.id,
            exchangeId: null,
            correlationId: null,
            payload: { participant },
            createdAt,
          },
        });
      }
      const opened = yield* send.send({
        commandId: CommCommandId.make("command:j5-a2a-lifecycle-command-path-open"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Archive the reply-owing participant through the real lifecycle command.",
        expectReply: true,
        intent: "Prove the production archive bridge",
        acceptedAt: createdAt,
      });

      const storedLifecycleEvents = yield* threads.streamStoredEventsFrom().pipe(
        Stream.filter(
          (stored) =>
            stored.event.threadId === receiver.threadId &&
            (stored.event.type === "thread.archived" || stored.event.type === "thread.deleted"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* threadLifecycle.archive({
        commandId: CommandId.make("command:j5-a2a-lifecycle-command-path-archive"),
        threadId: receiver.threadId,
      });
      yield* threadLifecycle.unarchive({
        commandId: CommandId.make("command:j5-a2a-lifecycle-command-path-unarchive"),
        threadId: receiver.threadId,
      });
      yield* threadLifecycle.delete({
        commandId: CommandId.make("command:j5-a2a-lifecycle-command-path-delete"),
        threadId: receiver.threadId,
      });
      const stored = yield* Fiber.join(storedLifecycleEvents);
      assert.deepStrictEqual(
        Array.from(stored, (event) => event.event.type),
        ["thread.archived", "thread.deleted"],
      );
      for (const event of stored) yield* lifecycle.handleStoredEvent(event);

      const state = yield* sql<{
        readonly status: string;
        readonly dropped_events: number;
        readonly terminal_notices: number;
        readonly participant_left_events: number;
      }>`
        SELECT
          exchange.status,
          (
            SELECT COUNT(*)
            FROM j5_a2a_comm_event
            WHERE kind = 'exchange.dropped' AND exchange_id = ${opened.exchangeId}
          ) AS dropped_events,
          (
            SELECT COUNT(*)
            FROM j5_a2a_delivery
            WHERE exchange_role = 'terminal_notice' AND exchange_id = ${opened.exchangeId}
          ) AS terminal_notices,
          (
            SELECT COUNT(*)
            FROM j5_a2a_comm_event
            WHERE kind = 'participant.left' AND receiver = ${receiver.id}
          ) AS participant_left_events
        FROM j5_a2a_exchange AS exchange
        WHERE exchange.exchange_id = ${opened.exchangeId}
      `;
      assert.deepStrictEqual(state, [
        {
          status: "dropped",
          dropped_events: 1,
          terminal_notices: 1,
          participant_left_events: 1,
        },
      ]);
      assert.deepStrictEqual(yield* ledger.listMembership(squadronId), [
        {
          squadronId,
          participant: sender,
          joinedSeq: 1,
          updatedSeq: 1,
        },
      ]);
      const retiredSend = yield* Effect.flip(
        send.send({
          commandId: CommCommandId.make("command:j5-a2a-lifecycle-command-path-retired-send"),
          senderThreadId: receiver.threadId,
          to: sender.id,
          message: "Upstream unarchive must not revive A2A participation.",
          acceptedAt: createdAt,
        }),
      );
      assert.instanceOf(retiredSend, A2ASenderRetiredError);
      assert.include(retiredSend.message, "participant.left");
    }).pipe(Effect.provide(makeLifecycleTestLayer(harness)));
  }),
);

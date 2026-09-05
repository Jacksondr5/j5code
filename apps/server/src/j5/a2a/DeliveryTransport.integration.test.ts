import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../../mcp/McpSessionRegistry.testkit.ts";
import {
  OrchestrationEffectWorkerV2,
  type OrchestrationEffectWorkerV2Shape,
} from "../../orchestration-v2/EffectWorker.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2InterruptInput,
  ProviderAdapterV2Shape,
  ProviderAdapterV2SteerInput,
  ProviderAdapterV2TurnInput,
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
  astraPeerSteeringRun,
  ASTRA_PEER_DELIVERY_GUIDANCE,
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

/** The fake provider's view of one started turn, so a test can drive its tool batch and ending. */
interface FakeActiveTurn {
  readonly events: PubSub.PubSub<ProviderAdapterV2Event>;
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapterV2TurnInput["runId"];
  readonly runOrdinal: ProviderAdapterV2TurnInput["runOrdinal"];
  readonly rootNodeId: ProviderAdapterV2TurnInput["rootNodeId"];
  readonly attemptId: ProviderAdapterV2TurnInput["attemptId"];
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
}

interface DeliveryHarness {
  readonly staleProjection: Ref.Ref<OrchestrationV2ThreadProjection | undefined>;
  readonly deliveryInvocations: Ref.Ref<ReadonlyArray<DeliveryInvocation>>;
  readonly steerInputs: Ref.Ref<ReadonlyArray<ProviderAdapterV2SteerInput>>;
  readonly interruptInputs: Ref.Ref<ReadonlyArray<ProviderAdapterV2InterruptInput>>;
  readonly activeTurns: Ref.Ref<ReadonlyMap<ThreadId, FakeActiveTurn>>;
}

const makeOrchestrationAdapter = (harness: DeliveryHarness): ProviderAdapterV2Shape => ({
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
            const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
            yield* Ref.update(harness.activeTurns, (existing) =>
              new Map(existing).set(input.threadId, {
                events,
                threadId: input.threadId,
                runId: input.runId,
                runOrdinal: input.runOrdinal,
                rootNodeId: input.rootNodeId,
                attemptId: input.attemptId,
                providerThreadId: input.providerThread.id,
                providerTurnId,
              }),
            );
            yield* PubSub.publish(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: providerTurnId,
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
        steerTurn: (input) => Ref.update(harness.steerInputs, (existing) => [...existing, input]),
        interruptTurn: (input) =>
          Ref.update(harness.interruptInputs, (existing) => [...existing, input]),
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
  const orchestrationAdapter = makeOrchestrationAdapter(harness);
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
        getThreadProjection: (threadId) =>
          Ref.get(harness.staleProjection).pipe(
            Effect.flatMap((stale) =>
              stale === undefined ? threads.getThreadProjection(threadId) : Effect.succeed(stale),
            ),
          ),
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
    staleProjection: yield* Ref.make<OrchestrationV2ThreadProjection | undefined>(undefined),
    deliveryInvocations: yield* Ref.make<ReadonlyArray<DeliveryInvocation>>([]),
    steerInputs: yield* Ref.make<ReadonlyArray<ProviderAdapterV2SteerInput>>([]),
    interruptInputs: yield* Ref.make<ReadonlyArray<ProviderAdapterV2InterruptInput>>([]),
    activeTurns: yield* Ref.make<ReadonlyMap<ThreadId, FakeActiveTurn>>(new Map()),
  } satisfies DeliveryHarness;
});

const seedTarget = (suffix: string, model = modelSelection.model) =>
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
      modelSelection: { ...modelSelection, model },
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

for (const idleModel of ["gpt-5.4", "gpt-6-astra"]) {
  it.effect(
    `starts an idle ${idleModel} recipient immediately without the implicit auto mode`,
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagementService;
          const transport = yield* A2ADeliveryTransport;
          const target = yield* seedTarget("idle", idleModel);

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
          const worker = yield* OrchestrationEffectWorkerV2;
          const sink = yield* EventSinkV2;
          const running = yield* sink.stream({ threadId: target.threadId }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "running",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* worker.runOnce;
          yield* Fiber.join(running);
          // A queue receipt stays valid after its Astra run becomes steerable.
          yield* transport.deliverAgent(target.delivery);
          assert.lengthOf(yield* Ref.get(harness.steerInputs), 0);
          assert.lengthOf((yield* threads.getThreadProjection(target.threadId)).runs, 1);
        }).pipe(Effect.provide(makeTestLayer(harness)));
      }),
  );
}

/** Runs outbox effects as they become available until the awaited receipt lands. */
const runWorkerUntil = <A, E>(
  worker: OrchestrationEffectWorkerV2Shape,
  receipt: Fiber.Fiber<A, E>,
) =>
  Effect.gen(function* () {
    // Only the wait is raced; a claimed effect always runs to completion so
    // its lease and provider session are never abandoned mid-flight.
    while (receipt.pollUnsafe() === undefined) {
      yield* Effect.raceFirst(Fiber.join(receipt), worker.awaitWork);
      yield* worker.drain();
    }
    return yield* Fiber.join(receipt);
  });

/** Emits one fake shell tool call inside the active turn, the way the #73 repro's Bash and sibling calls appear. */
const publishCommandExecution = (
  turn: FakeActiveTurn,
  input: {
    readonly ordinal: number;
    readonly command: string;
    readonly status: "running" | "completed";
    readonly startedAt: DateTime.Utc;
    readonly completedAt: DateTime.Utc | null;
  },
) =>
  PubSub.publish(turn.events, {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: TurnItemId.make(`turn-item:${turn.threadId}:${turn.runOrdinal}:${input.ordinal}`),
      threadId: turn.threadId,
      runId: turn.runId,
      nodeId: turn.rootNodeId,
      providerThreadId: turn.providerThreadId,
      providerTurnId: turn.providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: turn.runOrdinal * 100 + input.ordinal,
      status: input.status,
      title: null,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      updatedAt: input.completedAt ?? input.startedAt,
      type: "command_execution",
      input: input.command,
      ...(input.status === "completed" ? { output: "", exitCode: 0 } : {}),
    },
  });

for (const model of ["gpt-6-astra", "astra"]) {
  it.effect(`delivers updates into a running ${model} turn without restarting its tools`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService;
        const transport = yield* A2ADeliveryTransport;
        const worker = yield* OrchestrationEffectWorkerV2;
        const sink = yield* EventSinkV2;
        const target = yield* seedTarget(model, model);
        const active = yield* threads.sendToThread({
          projectId: target.projectId,
          threadId: target.threadId,
          commandId: CommandId.make(`command:${model}:start`),
          messageId: MessageId.make(`message:${model}:start`),
          text: "Finish the original build while receiving updates.",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        // Starting/preparing is not a live provider turn: never use auto/restart.
        const starting = yield* threads.getThreadProjection(target.threadId);
        assert.isUndefined(astraPeerSteeringRun(starting, "peer"));
        const running = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* worker.runOnce;
        yield* Fiber.join(running);
        const projection = yield* threads.getThreadProjection(target.threadId);
        assert.equal(astraPeerSteeringRun(projection, "peer")?.id, active.run.id);
        for (const channel of ["silence_notice", "lifecycle_notice"] as const) {
          assert.isUndefined(astraPeerSteeringRun(projection, channel));
        }
        for (const otherModel of ["gpt-5.6-sol", "gpt-6-astra-custom", "claude-fable-5-1"]) {
          assert.isUndefined(
            astraPeerSteeringRun(
              {
                ...projection,
                runs: projection.runs.map((run) => ({
                  ...run,
                  modelSelection: { ...run.modelSelection, model: otherModel },
                })),
              },
              "peer",
            ),
          );
        }
        assert.isUndefined(
          astraPeerSteeringRun(
            {
              ...projection,
              providerThreads: projection.providerThreads.map((thread) => ({
                ...thread,
                driver: ProviderDriverKind.make("claude"),
              })),
            },
            "peer",
          ),
        );
        assert.isUndefined(astraPeerSteeringRun({ ...projection, providerSessions: [] }, "peer"));
        assert.isUndefined(
          astraPeerSteeringRun(
            { ...projection, thread: { ...projection.thread, archivedAt: yield* DateTime.now } },
            "peer",
          ),
        );
        assert.isUndefined(
          astraPeerSteeringRun(
            {
              ...projection,
              providerSessions: projection.providerSessions.map((session) => ({
                ...session,
                driver: ProviderDriverKind.make("claude"),
              })),
            },
            "peer",
          ),
        );
        assert.isUndefined(
          astraPeerSteeringRun(
            {
              ...projection,
              providerSessions: projection.providerSessions.map((session) => ({
                ...session,
                capabilities: {
                  ...session.capabilities,
                  turns: { ...session.capabilities.turns, supportsActiveSteering: false },
                },
              })),
            },
            "peer",
          ),
        );
        assert.isUndefined(astraPeerSteeringRun({ ...projection, providerTurns: [] }, "peer"));
        const turn = (yield* Ref.get(harness.activeTurns)).get(target.threadId)!;
        const startedAt = yield* DateTime.now;
        yield* publishCommandExecution(turn, {
          ordinal: 1,
          command: "long build",
          status: "running",
          startedAt,
          completedAt: null,
        });
        // The picker can change while the current run retains its original model.
        const orchestrator = yield* OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`command:${model}:picker-change`),
          threadId: target.threadId,
          modelSelection: { ...modelSelection, model: "gpt-5.6-sol" },
        });
        const firstDelivery = yield* transport
          .deliverAgent(target.delivery)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* runWorkerUntil(worker, firstDelivery);
        yield* transport.deliverAgent(target.delivery);
        const secondId = LedgerMessageId.make(`message:${model}:second`);
        const secondDelivery = yield* transport
          .deliverAgent({
            ...target.delivery,
            messageId: secondId,
            exchangeRole: "reply",
            message: "The answer to your question.",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* runWorkerUntil(worker, secondDelivery);
        const steers = yield* Ref.get(harness.steerInputs);
        assert.lengthOf(steers, 2);
        assert.sameMembers(
          steers.map((input) => input.message.messageId),
          [deliveryMessageId(target.messageId), deliveryMessageId(secondId)],
        );
        for (const steer of steers) {
          assert.equal(steer.runId, active.run.id);
          assert.equal(steer.providerTurnId, turn.providerTurnId);
          assert.include(steer.message.text, ASTRA_PEER_DELIVERY_GUIDANCE);
        }
        const toolCompleted = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "turn-item.updated" &&
              stored.event.payload.type === "command_execution" &&
              stored.event.payload.status === "completed",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* publishCommandExecution(turn, {
          ordinal: 1,
          command: "long build",
          status: "completed",
          startedAt,
          completedAt: yield* DateTime.now,
        });
        yield* Fiber.join(toolCompleted);
        const after = yield* threads.getThreadProjection(target.threadId);
        assert.lengthOf(after.runs, 1);
        assert.equal(after.runs[0]?.status, "running");
        assert.lengthOf(after.attempts, 1);
        assert.lengthOf(yield* Ref.get(harness.interruptInputs), 0);
        assert.lengthOf(
          after.messages.filter((message) => message.id === deliveryMessageId(target.messageId)),
          1,
        );
        // Notices remain queued even for Astra; they do not become peer steers.
        for (const channel of ["silence_notice", "lifecycle_notice"] as const) {
          yield* transport.deliverAgent({
            ...target.delivery,
            messageId: LedgerMessageId.make(`message:${model}:${channel}`),
            envelopeChannel: channel,
          });
        }
        assert.isFalse(yield* worker.runOnce);
        assert.lengthOf(yield* Ref.get(harness.steerInputs), 2);
        const withNotices = yield* threads.getThreadProjection(target.threadId);
        assert.equal(withNotices.runs.filter((run) => run.status === "queued").length, 2);
        // A provider turn can finish between the eligibility read and dispatch.
        // Keep the stale eligibility snapshot while the real projection moves on.
        const ended = yield* sink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "completed",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* PubSub.publish(turn.events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            ...projection.providerTurns[0]!,
            status: "completed",
            completedAt: yield* DateTime.now,
          },
        });
        yield* Fiber.join(ended);
        yield* Ref.set(harness.staleProjection, projection);
        const racedDelivery = {
          ...target.delivery,
          messageId: LedgerMessageId.make(`message:${model}:race`),
        };
        for (let retry = 0; retry < 2; retry++) {
          const failure = yield* Effect.flip(transport.deliverAgent(racedDelivery));
          assert.equal(failure._tag, "A2ADeliveryTransportError");
        }
        yield* Ref.set(harness.staleProjection, undefined);
        const afterRace = yield* threads.getThreadProjection(target.threadId);
        assert.isFalse(
          afterRace.messages.some(
            (message) => message.id === deliveryMessageId(racedDelivery.messageId),
          ),
        );
        assert.lengthOf(yield* Ref.get(harness.interruptInputs), 0);
      }).pipe(Effect.provide(makeTestLayer(harness)));
    }),
  );
}

it.effect(
  "queues behind a busy recipient's active turn and never aborts its running tool batch",
  () =>
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
        const turn = (yield* Ref.get(harness.activeTurns)).get(target.threadId);
        assert.isDefined(turn);

        // Issue #73's deterministic shape: a long shell call is in flight and its
        // sibling has not started when the peer message lands mid-turn.
        const toolStartedAt = yield* DateTime.now;
        yield* publishCommandExecution(turn!, {
          ordinal: 1,
          command: "sleep 20",
          status: "running",
          startedAt: toolStartedAt,
          completedAt: null,
        });

        yield* transport.deliverAgent(target.delivery);
        yield* transport.deliverAgent(target.delivery);
        // Queueing schedules no provider effect: nothing steers or interrupts.
        assert.isFalse(yield* worker.runOnce);

        const upstreamMessageId = deliveryMessageId(target.messageId);
        const queuedProjection = yield* threads.getThreadProjection(target.threadId);
        const deliveredMessages = queuedProjection.messages.filter(
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
        assert.lengthOf(queuedProjection.runs, 2);
        const queuedRun = queuedProjection.runs.find(
          (candidate) => candidate.userMessageId === upstreamMessageId,
        );
        assert.equal(queuedRun?.status, "queued");
        assert.equal(deliveredMessages[0]?.runId, queuedRun?.id);
        assert.equal(
          queuedProjection.runs.find((candidate) => candidate.id === active.run.id)?.status,
          "running",
        );
        assert.isUndefined(
          queuedProjection.turnItems.find(
            (candidate) =>
              candidate.type === "user_message" && candidate.messageId === upstreamMessageId,
          ),
        );
        assert.deepStrictEqual(
          (yield* Ref.get(harness.deliveryInvocations))
            .filter((invocation) => invocation.messageId === upstreamMessageId)
            .map((invocation) => invocation.mode),
          ["queue", "queue"],
        );
        assert.lengthOf(yield* Ref.get(harness.steerInputs), 0);
        assert.lengthOf(yield* Ref.get(harness.interruptInputs), 0);

        // The sibling starts after the incoming message and completes normally,
        // then the long call and the turn end on their own.
        const activeCompleted = yield* eventSink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.runId === active.run.id &&
              stored.event.payload.status === "completed",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const toolCompletedAt = yield* DateTime.now;
        yield* publishCommandExecution(turn!, {
          ordinal: 2,
          command: "echo sibling",
          status: "completed",
          startedAt: toolCompletedAt,
          completedAt: toolCompletedAt,
        });
        yield* publishCommandExecution(turn!, {
          ordinal: 1,
          command: "sleep 20",
          status: "completed",
          startedAt: toolStartedAt,
          completedAt: toolCompletedAt,
        });
        yield* PubSub.publish(turn!.events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            id: turn!.providerTurnId,
            providerThreadId: turn!.providerThreadId,
            nodeId: turn!.rootNodeId,
            runAttemptId: turn!.attemptId,
            nativeTurnRef: {
              driver,
              nativeId: `native-turn:${turn!.attemptId}`,
              strength: "strong",
            },
            ordinal: turn!.runOrdinal,
            status: "completed",
            startedAt: toolStartedAt,
            completedAt: toolCompletedAt,
          },
        });
        yield* PubSub.publish(turn!.events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn!.providerThreadId,
          providerTurnId: turn!.providerTurnId,
          runOrdinal: turn!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        // Completion lands once the worker captures the run's checkpoint.
        yield* runWorkerUntil(worker, activeCompleted);

        // The queued delivery becomes the next turn only after the active one ends.
        const queuedRunning = yield* eventSink.stream({ threadId: target.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.runId === queuedRun?.id &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* runWorkerUntil(worker, queuedRunning);

        const projection = yield* threads.getThreadProjection(target.threadId);
        assert.equal(
          projection.runs.find((candidate) => candidate.id === active.run.id)?.status,
          "completed",
        );
        assert.deepStrictEqual(
          projection.turnItems
            .filter((candidate) => candidate.type === "command_execution")
            .map((candidate) => candidate.status),
          ["completed", "completed"],
        );
        assert.equal(
          projection.runs.find((candidate) => candidate.id === queuedRun?.id)?.status,
          "running",
        );
        assert.equal(
          projection.turnItems.find(
            (
              candidate,
            ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
              candidate.type === "user_message" && candidate.messageId === upstreamMessageId,
          )?.inputIntent,
          "queued_turn",
        );
        assert.lengthOf(yield* Ref.get(harness.steerInputs), 0);
        assert.lengthOf(yield* Ref.get(harness.interruptInputs), 0);
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

it.effect("does not acknowledge a committed Astra steer when its turn ends before execution", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const transport = yield* A2ADeliveryTransport;
      const worker = yield* OrchestrationEffectWorkerV2;
      const sink = yield* EventSinkV2;
      const target = yield* seedTarget("post-commit-race", "gpt-6-astra");
      const running = yield* sink.stream({ threadId: target.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "provider-turn.updated" &&
            stored.event.payload.status === "running",
        ),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* threads.sendToThread({
        projectId: target.projectId,
        threadId: target.threadId,
        commandId: CommandId.make("command:post-commit-race:start"),
        messageId: MessageId.make("message:post-commit-race:start"),
        text: "Inspect until the update arrives.",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.runOnce;
      yield* Fiber.join(running);
      const projection = yield* threads.getThreadProjection(target.threadId);
      const turn = (yield* Ref.get(harness.activeTurns)).get(target.threadId)!;
      const committed = yield* sink.stream({ threadId: target.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "turn-item.updated" &&
            stored.event.payload.type === "user_message" &&
            stored.event.payload.inputIntent === "steer",
        ),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      const delivery = yield* transport
        .deliverAgent(target.delivery)
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* Fiber.join(committed);
      const ended = yield* sink.stream({ threadId: target.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "provider-turn.updated" &&
            stored.event.payload.status === "completed",
        ),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* PubSub.publish(turn.events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: {
          ...projection.providerTurns[0]!,
          status: "completed",
          completedAt: yield* DateTime.now,
        },
      });
      yield* Fiber.join(ended);
      // Drive the real worker's five attempts with controlled time, never sleeps.
      for (const delay of [0, 100, 200, 400, 800]) {
        yield* TestClock.adjust(delay);
        yield* worker.drain();
      }
      const outcome = yield* Fiber.join(delivery);
      assert.equal(
        outcome._tag,
        "A2ADeliveryTransportError",
        "A2A must fail when no adapter call occurred",
      );
      // Once the turn has ended, retries still read the same failed steer receipt.
      for (let retry = 0; retry < 2; retry++) {
        const failure = yield* Effect.flip(transport.deliverAgent(target.delivery));
        assert.equal(failure._tag, "A2ADeliveryTransportError");
      }
      const after = yield* threads.getThreadProjection(target.threadId);
      assert.lengthOf(after.runs, 1);
      assert.lengthOf(
        after.messages.filter((message) => message.id === deliveryMessageId(target.messageId)),
        1,
      );
      assert.lengthOf(yield* Ref.get(harness.steerInputs), 0);
      assert.lengthOf(yield* Ref.get(harness.interruptInputs), 0);
    }).pipe(Effect.provide(makeTestLayer(harness)));
  }),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../../mcp/McpSessionRegistry.testkit.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import { OrchestrationV2LayerLive } from "../../orchestration-v2/runtimeLayer.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
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
import { formatPeerEnvelope } from "./EnvelopeFormatter.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { CommCommandId, EpicId, ExchangeId, LedgerMessageId, ParticipantId } from "./contracts.ts";

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
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("provider sessions are not used by the A2 delivery seam test"),
} as ProviderAdapterV2Shape;
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

const orchestrationTestLayer = OrchestrationV2LayerLive.pipe(
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(checkpointStoreTestLayer),
  Layer.provide(serverConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(providerInstanceRegistryTestLayer),
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const testLayer = Layer.merge(ledgerLayer, deliveryTransportLayer).pipe(
  Layer.provideMerge(orchestrationTestLayer),
);

it.effect("delivers a stable peer envelope through real thread management exactly once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const threads = yield* ThreadManagementService;
    const ledger = yield* A2ALedger;
    const transport = yield* A2ADeliveryTransport;
    const threadId = ThreadId.make("thread:j5-a2a-delivery-target");
    const projectId = ProjectId.make("project:j5-a2a-delivery-target");
    const epicId = EpicId.make("epic:j5-a2a-delivery");
    const senderId = ParticipantId.make("agent:j5-a2a-delivery-sender");
    const receiverId = ParticipantId.make("agent:j5-a2a-delivery-receiver");
    const exchangeId = ExchangeId.make("exchange:j5-a2a-delivery");
    const messageId = LedgerMessageId.make("message:j5-a2a-delivery");
    const createdAt = "2026-08-17T12:00:00.000Z";
    const message = "Reply through the real delivery seam.";

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:j5-a2a-delivery-create-thread"),
      threadId,
      projectId,
      title: "J5 A2A delivery target",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/tmp/j5-a2a-delivery-target",
    });
    yield* ledger.createEpic({
      epic: { id: epicId, name: "J5 A2A delivery", createdAt },
    });
    yield* ledger.appendEvents({
      commandId: CommCommandId.make("command:j5-a2a-delivery-join-target"),
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

    const delivery = {
      originEpicId: epicId,
      receiverEpicId: epicId,
      messageId,
      senderId,
      receiverId,
      exchangeId,
      message,
    };
    yield* transport.deliverAgent(delivery);
    yield* transport.deliverAgent(delivery);

    const projection = yield* threads.getThreadProjection(threadId);
    const upstreamMessageId = deliveryMessageId(messageId);
    const deliveredMessages = projection.messages.filter(
      (candidate) => candidate.id === upstreamMessageId,
    );
    assert.lengthOf(deliveredMessages, 1);
    assert.equal(
      deliveredMessages[0]?.text,
      formatPeerEnvelope({ senderId, originEpicId: epicId, exchangeId, message }),
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
  }).pipe(Effect.provide(testLayer)),
);

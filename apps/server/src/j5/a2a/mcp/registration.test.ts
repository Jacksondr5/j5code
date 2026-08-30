import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import { J5ToolkitRegistrationLive } from "./registration.ts";

const Dependencies = Layer.mergeAll(
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(A2ADeliveryWorker)({}),
  Layer.mock(A2AHomeRegistrar)({}),
  Layer.mock(A2ALedger)({}),
  Layer.mock(ParticipantPlacementService)({}),
  Layer.mock(A2ASendService)({}),
  Layer.mock(SpawnCompositionService)({}),
  NodeServices.layer,
);

const TestLayer = J5ToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Dependencies),
);

it.effect("registers only the current J5 communication and verb slice", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    assert.deepStrictEqual(server.tools.map(({ tool }) => tool.name).toSorted(), [
      "list_participants",
      "send_message",
      "spawn_agent",
      "stop_agent",
    ]);
  }).pipe(Effect.provide(TestLayer)),
);

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { ArchiveAgentService } from "../ArchiveAgentService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import { A2A_SEND_TOOL_DESCRIPTION } from "../EnvelopeFormatter.ts";
import {
  J5OrchestratorSurfaceRegistrationLive,
  J5ToolkitRegistrationLive,
} from "./registration.ts";

const Dependencies = Layer.mergeAll(
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(OrchestratorV2)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(A2ADeliveryWorker)({}),
  Layer.mock(A2AHomeRegistrar)({}),
  Layer.mock(A2ALedger)({}),
  Layer.mock(ParticipantPlacementService)({}),
  Layer.mock(A2ASendService)({}),
  Layer.mock(SpawnCompositionService)({}),
  Layer.mock(ArchiveAgentService)({}),
  NodeServices.layer,
);

const TestLayer = Layer.mergeAll(
  J5OrchestratorSurfaceRegistrationLive,
  J5ToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpServer.McpServer.layer), Layer.provide(Dependencies));

it.effect("registers the exact composed production J5 orchestration surface", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    assert.deepStrictEqual(server.tools.map(({ tool }) => tool.name).toSorted(), [
      "archive_agent",
      "clear_own_ask",
      "delete_scheduled_task",
      "list_participants",
      "list_scheduled_tasks",
      "orchestrator_capabilities",
      "schedule_task",
      "send_message",
      "spawn_agent",
      "stop_agent",
      "t3_thread_list",
      "t3_thread_read",
      "t3_thread_wait",
      "update_scheduled_task",
    ]);
    const sendTool = server.tools.find(({ tool }) => tool.name === "send_message")?.tool;
    assert.equal(sendTool?.description, A2A_SEND_TOOL_DESCRIPTION);
  }).pipe(Effect.provide(TestLayer)),
);

import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import {
  J5OrchestratorSurface,
  J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION,
  J5_THREAD_READ_DESCRIPTION,
  J5_THREAD_WAIT_DESCRIPTION,
} from "./orchestratorSurface.ts";
import { J5OrchestratorSurfaceHandlersLive } from "./orchestratorSurfaceHandlers.ts";

const threadId = ThreadId.make("thread:j5:orchestrator-surface");
const providerInstanceId = ProviderInstanceId.make("codex-j5-orchestrator-surface");
const invocation = {
  environmentId: EnvironmentId.make("environment:j5:orchestrator-surface"),
  threadId,
  providerSessionId: "provider-session:j5:orchestrator-surface",
  providerInstanceId,
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "j5-orchestrator-surface-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const rawCapabilities = {
  parentThreadId: threadId,
  inheritedProviderInstanceId: providerInstanceId,
  inheritedModel: "gpt-5.6-sol",
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  providers: [
    {
      providerInstanceId,
      driverKind: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      models: [
        {
          id: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          options: [
            {
              id: "effort",
              label: "Reasoning effort",
              type: "select" as const,
              options: [
                { id: "high", label: "High", isDefault: true },
                { id: "xhigh", label: "Extra high" },
              ],
            },
          ],
        },
      ],
      canRunChildTask: false,
      canRunCrossProviderChildTask: false,
      constraints: ["Provider authentication is required."],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 20,
  },
};

const TestLayer = McpServer.toolkit(J5OrchestratorSurface).pipe(
  Layer.provide(J5OrchestratorSurfaceHandlersLive),
  Layer.provide(
    Layer.mock(OrchestratorMcpService)({
      capabilities: () => Effect.succeed(rawCapabilities),
    }),
  ),
  Layer.provideMerge(McpServer.McpServer.layer),
);

const hasKey = (value: unknown, key: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (typeof value !== "object" || value === null) return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((item) => hasKey(item, key));
};

it.effect("registers the exact fail-closed orchestration surface with factual descriptions", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual([
      "delete_scheduled_task",
      "list_scheduled_tasks",
      "orchestrator_capabilities",
      "schedule_task",
      "t3_thread_list",
      "t3_thread_read",
      "t3_thread_wait",
      "update_scheduled_task",
    ]);

    expect(
      server.tools.find(({ tool }) => tool.name === "orchestrator_capabilities")?.tool.description,
    ).toBe(J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION);
    expect(server.tools.find(({ tool }) => tool.name === "t3_thread_read")?.tool.description).toBe(
      J5_THREAD_READ_DESCRIPTION,
    );
    expect(server.tools.find(({ tool }) => tool.name === "t3_thread_wait")?.tool.description).toBe(
      J5_THREAD_WAIT_DESCRIPTION,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("maps capabilities without inherited or delegation claims", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "orchestrator_capabilities", arguments: {} })
      .pipe(
        Effect.provideService(McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      parentThreadId: threadId,
      runtimeMode: "full-access",
      interactionMode: "default",
      providers: [
        {
          providerInstanceId,
          driverKind: "codex",
          displayName: "Codex",
          models: rawCapabilities.providers[0]!.models,
          constraints: ["Provider authentication is required."],
        },
      ],
      features: {
        threadManagement: true,
        incrementalThreadRead: true,
        scheduledTasks: true,
      },
    });

    for (const excluded of [
      "inheritedProviderInstanceId",
      "inheritedModel",
      "canRunChildTask",
      "canRunCrossProviderChildTask",
      "appOwnedSubagents",
      "asyncPolling",
      "cancellation",
    ]) {
      expect(hasKey(result.structuredContent, excluded)).toBe(false);
    }
  }).pipe(Effect.provide(TestLayer)),
);

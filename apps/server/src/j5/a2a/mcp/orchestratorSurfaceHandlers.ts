import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { J5OrchestratorSurface, mapJ5OrchestratorCapabilities } from "./orchestratorSurface.ts";

const handlers = {
  orchestrator_capabilities: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.capabilities(scope).pipe(Effect.map(mapJ5OrchestratorCapabilities));
    }),
  schedule_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.scheduleTask(scope, input);
    }),
  list_scheduled_tasks: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope);
    }),
  update_scheduled_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.updateScheduledTask(scope, input);
    }),
  delete_scheduled_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  t3_thread_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.listThreads(scope, input);
    }),
  t3_thread_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.readThread(scope, input);
    }),
  t3_thread_wait: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.waitForThread(scope, input);
    }),
} satisfies Parameters<typeof J5OrchestratorSurface.toLayer>[0];

export const J5OrchestratorSurfaceHandlersLive = J5OrchestratorSurface.toLayer(handlers);

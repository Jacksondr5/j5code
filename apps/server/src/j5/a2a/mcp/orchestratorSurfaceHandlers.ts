import { delegateTask } from "../../agents/agentDelegation.ts";
import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { J5OrchestratorSurface, mapJ5OrchestratorCapabilities } from "./orchestratorSurface.ts";

// Declared as upstream declares the tools these stand in for.
const handlers = {
  delegate_task: McpToolAccess.actsAsCaller(delegateTask),
  orchestrator_capabilities: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.capabilities(scope).pipe(Effect.map(mapJ5OrchestratorCapabilities));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof J5OrchestratorSurface.tools>;

export const layer = McpToolAccess.toLayer(J5OrchestratorSurface, handlers);

import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import * as OrchestratorMcpService from "../../../mcp/OrchestratorMcpService.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import { J5OrchestratorSurface } from "./orchestratorSurface.ts";
import { J5OrchestratorSurfaceHandlersLive } from "./orchestratorSurfaceHandlers.ts";
import { J5Toolkit } from "./tools.ts";

/** The single shared J5 MCP registration; later J5 milestones extend J5Toolkit only. */
export const J5ToolkitRegistrationLive = McpServer.toolkit(J5Toolkit).pipe(
  Layer.provide(J5ToolkitHandlersLive),
  Layer.provide(OrchestratorMcpService.layer),
);

/** Fail-closed J5 view of retained upstream orchestration behavior. */
export const J5OrchestratorSurfaceRegistrationLive = McpServer.toolkit(J5OrchestratorSurface).pipe(
  Layer.provide(J5OrchestratorSurfaceHandlersLive),
  Layer.provide(OrchestratorMcpService.layer),
);

/** Authenticated toolkit; the server route graph provides the shared A2A runtime once. */
export const J5McpIntegrationLive = J5ToolkitRegistrationLive;

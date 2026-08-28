import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import * as OrchestratorMcpService from "../../../mcp/OrchestratorMcpService.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import { J5Toolkit } from "./tools.ts";
import { J5A2ARuntimeLayer } from "../runtimeLayer.ts";

/** The single shared J5 MCP registration; later J5 milestones extend J5Toolkit only. */
export const J5ToolkitRegistrationLive = McpServer.toolkit(J5Toolkit).pipe(
  Layer.provide(J5ToolkitHandlersLive),
  Layer.provide(OrchestratorMcpService.layer),
);

/** Authenticated toolkit plus its independently drainable A2A runtime. */
export const J5McpIntegrationLive = J5ToolkitRegistrationLive.pipe(
  Layer.provideMerge(J5A2ARuntimeLayer),
);

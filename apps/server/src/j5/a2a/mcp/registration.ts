import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { J5ToolkitHandlersLive } from "./handlers.ts";
import { J5Toolkit } from "./tools.ts";

/** The single shared J5 MCP registration; later J5 milestones extend J5Toolkit only. */
export const J5ToolkitRegistrationLive = McpServer.toolkit(J5Toolkit).pipe(
  Layer.provide(J5ToolkitHandlersLive),
);

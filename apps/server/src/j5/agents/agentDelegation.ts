import {
  AgentPersonaId,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import { DelegateTaskTool } from "../../mcp/toolkits/orchestrator/tools.ts";
import { invokeAgent } from "./agentInvocation.ts";

/**
 * Upstream's delegate_task input plus an optional saved agent. With `agent`, the server
 * applies the saved definition's instructions, model route, reasoning, and runtime policy;
 * without it, this is upstream's plain child delegation.
 */
export const J5DelegateTaskInput = Schema.Struct({
  ...OrchestratorMcpDelegateTaskInput.fields,
  agent: Schema.optional(
    AgentPersonaId.annotate({
      description:
        "Saved agent ID to run the child as, taken from an @agent:ID mention or the Settings → Agents library. The server applies its instructions, model route, reasoning, and runtime policy; omit target and runtimeMode when passing agent.",
    }),
  ),
});
export type J5DelegateTaskInput = typeof J5DelegateTaskInput.Type;

export const J5_DELEGATE_TASK_DESCRIPTION = `${DelegateTaskTool.description ?? ""} When the user writes @agent:ID or asks for a saved agent by name, pass agent=ID (the server pins that agent's provider, model, reasoning, and runtime policy; omit target and runtimeMode) and give a self-contained task; do not substitute a plain child if that call fails; report the error.`;

/** J5's delegate_task: the upstream tool with the saved-agent extension, registered in place of it. */
export const J5DelegateTaskTool = Tool.make("delegate_task", {
  description: J5_DELEGATE_TASK_DESCRIPTION,
  parameters: J5DelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext,
    OrchestratorMcpService,
    ThreadManagementService,
    ProviderRegistry.ProviderRegistry,
  ],
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const delegateTask = Effect.fn("j5.delegateTask")(function* (input: J5DelegateTaskInput) {
  const { agent, ...delegate } = input;
  if (agent === undefined) {
    const scope = yield* McpInvocationContext;
    const service = yield* OrchestratorMcpService;
    return yield* service.delegateTask(scope, delegate);
  }
  if (delegate.target !== undefined || delegate.runtimeMode !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "A saved agent pins its provider, model, reasoning, and runtime mode. Omit target and runtimeMode when passing agent.",
    });
  }
  const { target: _target, runtimeMode: _runtimeMode, ...personaDelegate } = delegate;
  return yield* invokeAgent({ personaId: agent, ...personaDelegate });
});

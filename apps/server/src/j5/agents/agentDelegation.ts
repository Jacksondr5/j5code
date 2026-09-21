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
import { invokeAgent } from "./agentInvocation.ts";

/**
 * Upstream's delegate_task input plus an optional persona. With `persona`, the server applies
 * the saved definition's instructions, model route, reasoning, and runtime policy; without it,
 * this is upstream's plain child delegation.
 */
export const J5DelegateTaskInput = Schema.Struct({
  ...OrchestratorMcpDelegateTaskInput.fields,
  persona: Schema.optional(
    AgentPersonaId.annotate({
      description:
        "Persona ID to run the child as, taken from an @persona:ID mention or the Settings → Personas library. The server applies its instructions, model route, reasoning, and runtime policy; omit target and runtimeMode when passing persona.",
    }),
  ),
});
export type J5DelegateTaskInput = typeof J5DelegateTaskInput.Type;

/**
 * Written for J5 rather than prefixed onto upstream's text: upstream's description tells the model to
 * use this tool for any subagent request, which contradicts the orchestration instructions that keep
 * ordinary subagent work provider-native. Here the persona use leads and the plain child is the
 * fallback.
 */
export const J5_DELEGATE_TASK_DESCRIPTION =
  "Run one task as a T3-owned child of THIS thread with only the supplied task prompt; parent conversation history is not copied. Pass persona=ID when the user writes @persona:ID or asks for a persona by name: the server pins that persona's instructions, provider, model, reasoning, and runtime policy, so omit target and runtimeMode. Give the persona a self-contained task, and if that call fails, report the error instead of substituting a plain child. Without persona, this is a plain T3-tracked child for cross-provider work or for work the user wants tracked as a T3 task; for an ordinary subagent request, use your provider's native subagent mechanism instead. The childThreadId is backing storage, not an ordinary top-level thread. Provider, model, model options (see orchestrator_capabilities), runtime mode, and interaction mode inherit unless target overrides them. Prefer mode='async' for long work; mode='wait' blocks until completion or timeout. timeoutMs on mode=wait is only the parent's wait budget and does not cancel the child. waitTimedOut on that wait call means the timeout fired; keep that taskId and read status on later task_status. An async child's completion wakes this thread with a continuation message naming the task (queued behind any turn in progress), so end the turn instead of polling or spawning watchers; use task_status only when the result is needed mid-turn.";

/** J5's delegate_task: the upstream tool with the persona extension, registered in place of it. */
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
  const { persona: personaId, ...delegate } = input;
  if (personaId === undefined) {
    const scope = yield* McpInvocationContext;
    const service = yield* OrchestratorMcpService;
    return yield* service.delegateTask(scope, delegate);
  }
  if (delegate.target !== undefined || delegate.runtimeMode !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "A persona pins its provider, model, reasoning, and runtime mode. Omit target and runtimeMode when passing persona.",
    });
  }
  // Both are undefined here (checked above); the destructure only narrows the type for invokeAgent.
  const { target: _target, runtimeMode: _runtimeMode, ...personaDelegate } = delegate;
  return yield* invokeAgent({ personaId, ...personaDelegate });
});

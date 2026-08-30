import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionDescriptor,
  RuntimeMode,
  ThreadId,
  type OrchestratorMcpCapabilitiesResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import {
  DeleteScheduledTaskTool,
  ListScheduledTasksTool,
  ScheduleTaskTool,
  ThreadListTool,
  UpdateScheduledTaskTool,
} from "../../../mcp/toolkits/orchestrator/tools.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OrchestratorMcpService];

export const J5OrchestratorProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.NullOr(Schema.String),
      options: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
    }),
  ),
  constraints: Schema.Array(Schema.String),
});

export const J5OrchestratorCapabilitiesResult = Schema.Struct({
  parentThreadId: ThreadId,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providers: Schema.Array(J5OrchestratorProviderCapability),
  features: Schema.Struct({
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
  }),
});

export const mapJ5OrchestratorCapabilities = (
  capabilities: OrchestratorMcpCapabilitiesResult,
): typeof J5OrchestratorCapabilitiesResult.Type => ({
  parentThreadId: capabilities.parentThreadId,
  runtimeMode: capabilities.runtimeMode,
  interactionMode: capabilities.interactionMode,
  providers: capabilities.providers.map((provider) => ({
    providerInstanceId: provider.providerInstanceId,
    driverKind: provider.driverKind,
    displayName: provider.displayName,
    models: provider.models.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.options === undefined ? {} : { options: model.options }),
    })),
    constraints: provider.constraints,
  })),
  features: {
    incrementalThreadRead: capabilities.features.incrementalThreadRead,
    scheduledTasks: capabilities.features.scheduledTasks,
  },
});

export const J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION =
  "List provider instances, models, selectable model options, provider constraints, and the current runtime and interaction modes available to this T3 thread.";

export const J5_THREAD_READ_DESCRIPTION =
  "Read durable state and a paginated timeline from a T3 thread in the calling project. The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Continue with afterPosition=nextPosition.";

export const J5_THREAD_WAIT_DESCRIPTION =
  "Wait for a T3 thread run in the calling project to reach a terminal durable state. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use t3_thread_read or t3_thread_list after timedOut=true.";

export const J5OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description: J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION,
  success: J5OrchestratorCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const J5ThreadReadTool = Tool.make("t3_thread_read", {
  description: J5_THREAD_READ_DESCRIPTION,
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a T3 thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const J5ThreadWaitTool = Tool.make("t3_thread_wait", {
  description: J5_THREAD_WAIT_DESCRIPTION,
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a T3 thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const J5OrchestratorSurface = Toolkit.make(
  J5OrchestratorCapabilitiesTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  DeleteScheduledTaskTool,
  ThreadListTool,
  J5ThreadReadTool,
  J5ThreadWaitTool,
);

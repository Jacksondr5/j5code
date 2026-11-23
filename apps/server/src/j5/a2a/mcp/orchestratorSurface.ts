import { J5DelegateTaskTool } from "../../agents/agentDelegation.ts";
import {
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { OrchestratorToolkit } from "../../../mcp/toolkits/orchestrator/tools.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OrchestratorMcpService];

/**
 * Upstream's answer in upstream's shape, which a linked environment's `delegate_task` decodes
 * (T3 Code's `RemoteDelegation`). J5 leaves out bulk create (register D2), so it says so.
 */
export const mapJ5OrchestratorCapabilities = (
  capabilities: OrchestratorMcpCapabilitiesResult,
): OrchestratorMcpCapabilitiesResult => ({
  ...capabilities,
  features: { ...capabilities.features, batchThreadCreation: false, maxBatchThreads: 0 },
});

export const J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION =
  "List providers, models, options, and runtime modes for `delegate_task` and `j5_spawn_agent`, and the provider, model and options this thread runs with. Short list. `search` finds others. Any catalog model works.";

const J5OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description: J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION,
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const upstreamInterrupt = OrchestratorToolkit.tools.t3_thread_interrupt;

/** Upstream's tool as shipped; its handler adds the Captain's rule (threadInterrupt.ts). */
const J5ThreadInterruptTool = Tool.make("t3_thread_interrupt", {
  description: upstreamInterrupt.description,
  parameters: upstreamInterrupt.parametersSchema,
  success: upstreamInterrupt.successSchema,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    ...dependencies,
    ThreadManagementService,
    AgentCrewInstanceService,
    SecureRandom.SecureRandom,
  ],
})
  .annotate(Tool.Title, "Interrupt a J5 thread")
  .annotate(Tool.Destructive, true);

/**
 * The orchestrator tools J5 declares itself: `delegate_task` takes a persona,
 * `orchestrator_capabilities` says J5 leaves out bulk create, and
 * `t3_thread_interrupt` lets a Captain stop its own seats. The upstream tools J5 registers
 * unchanged are in upstreamCatalog.ts.
 */
export const J5OrchestratorSurface = Toolkit.make(
  J5DelegateTaskTool,
  J5OrchestratorCapabilitiesTool,
  J5ThreadInterruptTool,
);

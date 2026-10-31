import type {
  ModelSelection,
  OrchestrationV2AgentPersonaAssignment,
  ProviderInstanceId,
} from "@t3tools/contracts";

/**
 * The model selection a composer sends for a thread. A saved-agent thread keeps its launch route:
 * the server rejects any model change with "has an immutable model route", so the composer must
 * never propose one. Draft state can remember a different pick (the model chosen before a saved
 * agent was assigned to the draft), which is exactly the case this collapses back onto the route.
 */
export const composerModelSelectionForThread = (
  assignment: OrchestrationV2AgentPersonaAssignment | undefined,
  fallback: ModelSelection,
): ModelSelection => assignment?.resolvedModelSelection ?? fallback;

/**
 * The provider instances the composer tries, in order. A saved agent's route comes first, so a
 * draft's slash commands, skills and runtime modes follow the agent, not the draft's earlier pick.
 */
export const composerProviderCandidates = (
  assignment: OrchestrationV2AgentPersonaAssignment | undefined,
  candidates: ReadonlyArray<ProviderInstanceId | null | undefined>,
): ReadonlyArray<ProviderInstanceId | null | undefined> => [
  assignment?.resolvedModelSelection.instanceId,
  ...candidates,
];

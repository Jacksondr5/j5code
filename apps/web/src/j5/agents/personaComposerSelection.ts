import type { OrchestrationV2AgentPersonaAssignment, ProviderInstanceId } from "@t3tools/contracts";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";

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

/**
 * The persona route a thread's composer follows: its current model, until a person picks another
 * there. A remembered pick that was never made on this thread (a draft's sticky model) is not one.
 */
export const personaRouteToFollow = (
  assignment: OrchestrationV2AgentPersonaAssignment | undefined,
  draft: { readonly modelSelectionExplicit?: boolean } | null,
) => (draft?.modelSelectionExplicit === true ? undefined : assignment);

export function usePersonaRouteToFollow(
  assignment: OrchestrationV2AgentPersonaAssignment | undefined,
  target: ComposerThreadTarget,
) {
  // A boolean, so typing in the draft does not re-render the composer's host.
  const modelSelectionExplicit = useComposerDraftStore(
    (store) => store.getComposerDraft(target)?.modelSelectionExplicit === true,
  );
  return personaRouteToFollow(assignment, { modelSelectionExplicit });
}

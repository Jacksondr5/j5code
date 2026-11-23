import { agentPersonaMentionItems } from "@t3tools/client-runtime/j5/agent-mentions";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { useEnvironmentQuery } from "../../state/query";
import { AgentDraftPicker } from "./AgentDraftPicker";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { AgentPersonaAssignmentControls } from "./AgentPersonaAssignmentControls";
import { useDraftAgentAssignment } from "./useDraftAgentAssignment";

/**
 * The new-task draft's saved agent, in its own row under the checkout row: the picker until one is
 * chosen, then its persona's name and remove action, which the composer's input row has no room for.
 */
export function DraftAgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
  readonly disabled: boolean;
}) {
  const draftAgent = useDraftAgentAssignment(props.draftKey, props.environmentId);
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  if (draftAgent.personaId !== null && draftAgent.assignment === null) return null;
  // No band when there is no persona to start as; it holds its place while the catalog loads.
  if (
    draftAgent.assignment === null &&
    (catalog.isSuccess || catalog.failure !== null) &&
    !catalog.isPending &&
    agentPersonaMentionItems(catalog.data ?? null, "").length === 0
  )
    return null;
  return (
    // Clips the 44-tall controls' padding to sit closer to the checkout row, without overlapping it.
    <View className="h-[36px] flex-row items-center overflow-hidden px-2">
      {draftAgent.assignment ? (
        <AgentPersonaAssignmentControls
          assignment={draftAgent.assignment}
          environmentId={props.environmentId}
          draftKey={props.draftKey}
        />
      ) : (
        <AgentDraftPicker
          environmentId={props.environmentId}
          draftKey={props.draftKey}
          disabled={props.disabled}
        />
      )}
    </View>
  );
}

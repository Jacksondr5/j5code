import { presentAgentPersonaAssignment } from "@t3tools/client-runtime/j5/agent-personas";
import type { OrchestrationV2AgentPersonaAssignment } from "@t3tools/contracts";

import { ComposerInlineControl } from "../../components/ComposerToolbar";

/** Replaces the model control for a persona thread: the launch route is fixed. */
export function AgentPersonaAssignmentControls(props: {
  readonly assignment: OrchestrationV2AgentPersonaAssignment;
}) {
  const presentation = presentAgentPersonaAssignment(props.assignment);
  return (
    <>
      <ComposerInlineControl
        accessibilityLabel={`Agent persona: ${presentation.personaLabel}`}
        emphasized
        icon="person.crop.circle"
        label={presentation.personaLabel}
        maxWidth={152}
        static
      />
      <ComposerInlineControl
        accessibilityLabel={`Assigned model: ${presentation.routeLabel}`}
        label={presentation.routeLabel}
        maxWidth={200}
        static
      />
    </>
  );
}

import {
  AGENT_PERSONA_DRIFT_MESSAGE,
  agentPersonaDrift,
  presentAgentPersonaAssignment,
} from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId, OrchestrationV2AgentPersonaAssignment } from "@t3tools/contracts";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/** Replaces the model control for a persona thread: the launch route is fixed. */
export function AgentPersonaAssignmentControls(props: {
  readonly assignment: OrchestrationV2AgentPersonaAssignment;
  /** When known, the current library is compared with the launch snapshot to show drift. */
  readonly environmentId?: EnvironmentId;
}) {
  const presentation = presentAgentPersonaAssignment(props.assignment);
  const catalog = useEnvironmentQuery(
    props.environmentId === undefined
      ? null
      : agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const drift = agentPersonaDrift(props.assignment, catalog.data);
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
      {drift === "changed" ? (
        <ComposerInlineControl
          accessibilityLabel="Agent definition changed since launch"
          accessibilityHint={AGENT_PERSONA_DRIFT_MESSAGE}
          icon="exclamationmark.triangle"
          label="Changed"
          maxWidth={120}
          static
        />
      ) : null}
    </>
  );
}

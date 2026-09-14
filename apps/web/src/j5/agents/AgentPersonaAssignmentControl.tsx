import {
  AGENT_PERSONA_DRIFT_MESSAGE,
  agentPersonaDrift,
  presentAgentPersonaAssignment,
} from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId, OrchestrationV2AgentPersonaAssignment } from "@t3tools/contracts";
import { BotIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { ComposerControl, ComposerControlIcon } from "../../components/chat/ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/** Replaces the model and mode controls for a persona thread: the launch route is fixed. */
export function AgentPersonaAssignmentControl(props: {
  readonly assignment: OrchestrationV2AgentPersonaAssignment;
  /** When known, the current library is compared with the launch snapshot to show drift. */
  readonly environmentId?: EnvironmentId;
  /** Present only for an unsent draft, where the choice can still be undone. */
  readonly onClear?: () => void;
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
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              type="button"
              disabled
              aria-label={`Agent persona: ${presentation.personaLabel}`}
            />
          }
        >
          <ComposerControlIcon icon={BotIcon} opticalSize="large" />
          {presentation.personaLabel}
        </TooltipTrigger>
        <TooltipPopup side="top">
          Assigned by an agent orchestrator when this task started.
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              type="button"
              disabled
              aria-label={`Assigned model: ${presentation.routeLabel}`}
              className="max-w-64 overflow-hidden text-ellipsis whitespace-nowrap"
            />
          }
        >
          {presentation.routeLabel}
        </TooltipTrigger>
        <TooltipPopup side="top">This persona's model route is fixed for this task.</TooltipPopup>
      </Tooltip>
      {props.onClear ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <ComposerControl type="button" aria-label="Remove agent" onClick={props.onClear} />
            }
          >
            <ComposerControlIcon icon={XIcon} />
          </TooltipTrigger>
          <TooltipPopup side="top">Start as a regular task instead.</TooltipPopup>
        </Tooltip>
      ) : null}
      {drift === "changed" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <ComposerControl
                type="button"
                disabled
                aria-label="Agent definition changed since launch"
                className="text-warning-foreground"
              />
            }
          >
            <ComposerControlIcon icon={TriangleAlertIcon} />
            Changed
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-72">
            {AGENT_PERSONA_DRIFT_MESSAGE}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}

import { presentAgentPersonaAssignment } from "@t3tools/client-runtime/j5/agent-personas";
import type { OrchestrationV2AgentPersonaAssignment } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";

import { ComposerControl, ComposerControlIcon } from "../../components/chat/ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

/** Replaces the model and mode controls for a persona thread: the launch route is fixed. */
export function AgentPersonaAssignmentControl(props: {
  readonly assignment: OrchestrationV2AgentPersonaAssignment;
}) {
  const presentation = presentAgentPersonaAssignment(props.assignment);

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
    </>
  );
}

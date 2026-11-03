import { presentAgentHandoff } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FileTextIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/**
 * The handoff status an older run recorded for a task: written, pending, or missing. Read-only:
 * runs no longer record one, so it renders nothing for them. Opens the Artifacts page at the file.
 * Every chip in an environment reads the same environment-wide query.
 */
export function AgentHandoffChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly className?: string;
}) {
  const handoffs = useEnvironmentQuery(
    agentPersonaEnvironment.handoffs({ environmentId: props.environmentId, input: {} }),
  );
  const handoff = handoffs.data?.handoffs.find((entry) => entry.threadId === props.threadId);
  if (handoff === undefined) return null;
  const presentation = presentAgentHandoff(handoff);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/artifacts"
            search={{
              environmentId: props.environmentId,
              projectId: handoff.projectId,
              path: handoff.path,
            }}
            aria-label={presentation.detail}
            className={props.className}
          />
        }
      >
        <Badge
          variant={
            presentation.tone === "success"
              ? "success"
              : presentation.tone === "warning"
                ? "warning"
                : "error"
          }
        >
          <FileTextIcon aria-hidden className="size-3" />
          {presentation.label}
        </Badge>
      </TooltipTrigger>
      <TooltipPopup side="top">{presentation.detail}</TooltipPopup>
    </Tooltip>
  );
}

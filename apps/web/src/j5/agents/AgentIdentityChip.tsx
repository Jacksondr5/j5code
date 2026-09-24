import { presentAgentPersonaAssignment } from "@t3tools/client-runtime/j5/agent-personas";
import type {
  EnvironmentId,
  OrchestrationV2AgentPersonaAssignment,
  ThreadId,
} from "@t3tools/contracts";
import { BotIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useThreadShell } from "../../state/entities";

/** Compact "which persona is this" chip for thread cards and runtime rows. */
export function AgentIdentityChip(props: {
  readonly assignment: OrchestrationV2AgentPersonaAssignment | undefined;
  readonly className?: string;
}) {
  if (props.assignment === undefined) return null;
  const presentation = presentAgentPersonaAssignment(props.assignment);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={
              props.className ??
              "inline-flex max-w-36 shrink-0 items-center gap-1 truncate rounded-sm border border-border/60 px-1 text-[.65rem] text-muted-foreground"
            }
          />
        }
      >
        <BotIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{presentation.personaLabel}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        Persona {presentation.personaLabel} · {presentation.routeLabel} ·{" "}
        {props.assignment.authorityPolicy}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Persona label for upstream's lineage and subagent-card rows (#12835 replaced
 * the Agents panel). Those rows are already buttons with their own hover card,
 * so this stays a plain, non-interactive label: no nested tooltip or link.
 */
export function AgentLineageIdentity(props: {
  readonly environmentId: EnvironmentId;
  readonly childThreadId: string | null;
}) {
  const shell = useThreadShell(
    props.childThreadId !== null
      ? { environmentId: props.environmentId, threadId: props.childThreadId as ThreadId }
      : null,
  );
  const assignment = shell?.agentPersonaAssignment;
  if (assignment === undefined) return null;
  return (
    <span
      data-j5-agent-identity=""
      className="inline-flex max-w-28 shrink-0 items-center gap-1 truncate rounded-sm border border-border/60 px-1 text-[.65rem] text-muted-foreground"
    >
      <BotIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{presentAgentPersonaAssignment(assignment).personaLabel}</span>
    </span>
  );
}

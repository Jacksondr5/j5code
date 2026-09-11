import { presentAgentPersonaAssignment } from "@t3tools/client-runtime/j5/agent-personas";
import type {
  EnvironmentId,
  OrchestrationV2AgentPersonaAssignment,
  ThreadId,
} from "@t3tools/contracts";
import { BotIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useThreadShell } from "../../state/entities";

/** Compact "which saved agent is this" chip for thread cards and runtime rows. */
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
        Agent {presentation.personaLabel} · {presentation.routeLabel} ·{" "}
        {props.assignment.authorityPolicy}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Runtime rows know only the child thread; look up its shell for the pinned assignment. */
export function AgentRowIdentity(props: {
  readonly environmentId: EnvironmentId | null;
  readonly childThreadId: string | null;
}) {
  const shell = useThreadShell(
    props.environmentId !== null && props.childThreadId !== null
      ? { environmentId: props.environmentId, threadId: props.childThreadId as ThreadId }
      : null,
  );
  return <AgentIdentityChip assignment={shell?.agentPersonaAssignment} />;
}

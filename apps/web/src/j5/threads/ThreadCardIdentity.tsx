import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2AgentPersonaAssignment,
  ThreadId,
} from "@t3tools/contracts";

import { Badge } from "../../components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { AgentIdentityChip } from "../agents/AgentIdentityChip";
import { CaptainMark } from "../crew/CaptainMark";
import {
  presentCrewMembership,
  useCrewMembership,
  type ThreadCrewMembership,
} from "../crew/CrewMembershipsClient";

/**
 * Thread cards name the thread's project, as upstream's do. A thread launched as
 * a persona shows that persona beside it; a Crew member adds a seat chip and a
 * Captain adds the anchor mark. The list itself stays flat by recency, and the
 * grouped org tree belongs to the Roster.
 */
export function ThreadCardIdentity(props: {
  readonly threadId?: ThreadId;
  /** With `threadId`, names the environment the Crew chip is read from. */
  readonly environmentId?: EnvironmentId;
  /** The project's display name, as upstream's card shows it. */
  readonly projectName: string | null;
  /** Threads launched as a persona show the persona beside their project. */
  readonly agentPersonaAssignment?: OrchestrationV2AgentPersonaAssignment | undefined;
}) {
  const membership = useCrewMembership(
    props.threadId === undefined || props.environmentId === undefined
      ? undefined
      : scopeThreadRef(props.environmentId, props.threadId),
  );
  return (
    <ThreadCardIdentityView
      projectName={props.projectName}
      agentPersonaAssignment={props.agentPersonaAssignment}
      membership={membership}
    />
  );
}

export function ThreadCardIdentityView(props: {
  readonly projectName: string | null;
  readonly agentPersonaAssignment?: OrchestrationV2AgentPersonaAssignment | undefined;
  readonly membership: ThreadCrewMembership | undefined;
}) {
  const label = props.projectName;
  const chip = presentCrewMembership(props.membership);
  const agent = <AgentIdentityChip assignment={props.agentPersonaAssignment} />;
  if (label === null && chip === null)
    return <span className="flex flex-1 items-center gap-1">{agent}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {agent}
      {label === null ? null : (
        <Tooltip>
          <TooltipTrigger render={<span className="block min-w-0 truncate">{label}</span>} />
          <TooltipPopup>{label}</TooltipPopup>
        </Tooltip>
      )}
      {chip === null ? null : chip.kind === "captain" ? (
        <CaptainMark title={chip.title} />
      ) : (
        <Badge
          variant="outline"
          size="sm"
          className="max-w-[14ch] shrink-0"
          title={chip.title}
          data-testid="thread-card-crew-chip"
        >
          <span className="truncate">{chip.label}</span>
        </Badge>
      )}
    </span>
  );
}

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2AgentPersonaAssignment,
  ThreadId,
} from "@t3tools/contracts";

import { Badge } from "../../components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { AgentIdentityChip } from "../agents/AgentIdentityChip";
import { CaptainMark } from "./CaptainMark";
import {
  presentCrewMembership,
  useCrewMembership,
  type ThreadCrewMembership,
} from "./CrewMembershipsClient";
import type { ThreadHome } from "./ThreadHomesClient";

/**
 * Thread cards identify registered work by its immutable Registrar Squadron.
 * Native threads have no Registrar home, so their existing folder label stays
 * as the honest fallback rather than inventing a Squadron. A thread launched as
 * a persona shows that persona beside its home; a Crew member adds a seat chip
 * and a Captain adds the anchor mark. The list itself stays flat by recency, and
 * the grouped org tree belongs to the Roster.
 */
export function ThreadCardIdentity(props: {
  readonly threadId?: ThreadId;
  /** With `threadId`, names the environment the Crew chip is read from. */
  readonly environmentId?: EnvironmentId;
  readonly home: ThreadHome | undefined;
  readonly fallbackFolder: string | null;
  /** Threads launched as a persona show the persona beside their home. */
  readonly agentPersonaAssignment?: OrchestrationV2AgentPersonaAssignment | undefined;
}) {
  const membership = useCrewMembership(
    props.threadId === undefined || props.environmentId === undefined
      ? undefined
      : scopeThreadRef(props.environmentId, props.threadId),
  );
  return (
    <ThreadCardIdentityView
      home={props.home}
      fallbackFolder={props.fallbackFolder}
      agentPersonaAssignment={props.agentPersonaAssignment}
      membership={membership}
    />
  );
}

export function ThreadCardIdentityView(props: {
  readonly home: ThreadHome | undefined;
  readonly fallbackFolder: string | null;
  readonly agentPersonaAssignment?: OrchestrationV2AgentPersonaAssignment | undefined;
  readonly membership: ThreadCrewMembership | undefined;
}) {
  const label = props.home?.kind === "known" ? props.home.squadron.name : props.fallbackFolder;
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
          className="max-w-[14ch] shrink-0 truncate px-1.5 py-0 text-[10px] font-medium"
          title={chip.title}
          data-testid="thread-card-crew-chip"
        >
          {chip.label}
        </Badge>
      )}
    </span>
  );
}

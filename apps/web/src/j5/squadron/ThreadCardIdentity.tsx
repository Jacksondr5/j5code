import type { OrchestrationV2AgentPersonaAssignment } from "@t3tools/contracts";

import type { ThreadHome } from "./ThreadHomesClient";
import { AgentIdentityChip } from "../agents/AgentIdentityChip";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

/**
 * Thread cards identify registered work by its immutable Registrar Squadron.
 * Native threads have no Registrar home, so their existing folder label stays
 * as the honest fallback rather than inventing a Squadron.
 */
export function ThreadCardIdentity(props: {
  readonly home: ThreadHome | undefined;
  readonly fallbackFolder: string | null;
  /** Threads launched as a saved agent show the agent beside their home. */
  readonly agentPersonaAssignment?: OrchestrationV2AgentPersonaAssignment | undefined;
}) {
  const label = props.home?.kind === "known" ? props.home.squadron.name : props.fallbackFolder;
  const agent = <AgentIdentityChip assignment={props.agentPersonaAssignment} />;
  return label === null ? (
    <span className="flex flex-1 items-center gap-1">{agent}</span>
  ) : (
    <span className="flex min-w-0 items-center gap-1">
      {agent}
      <Tooltip>
        <TooltipTrigger render={<span className="block min-w-0 truncate">{label}</span>} />
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    </span>
  );
}

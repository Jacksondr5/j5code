import { agentPersonaMentionItems } from "@t3tools/client-runtime/j5/agent-mentions";
import type { EnvironmentId } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";

import { ComposerControl, ComposerControlIcon } from "../../components/chat/ComposerControl";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { useEnvironmentQuery } from "../../state/query";
import { selectDraftAgent } from "./agentDraftState";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/**
 * "Start as agent" for a new-task draft. Lists launchable agents only; choosing one pins
 * its route in the composer until the first send, when the server resolves the assignment.
 */
export function AgentDraftPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
  readonly size: "xs" | "sm";
  readonly disabled?: boolean;
}) {
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const agents = agentPersonaMentionItems(catalog.data ?? null, "");
  if (agents.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        aria-label="Start this task as a saved agent"
        render={<ComposerControl type="button" size={props.size} />}
      >
        <ComposerControlIcon icon={BotIcon} size={props.size} />
        Agent
      </MenuTrigger>
      <MenuPopup align="start">
        {agents.map((agent) => (
          <MenuItem
            key={agent.personaId}
            onClick={() => selectDraftAgent(props.draftKey, agent.personaId)}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{agent.label}</span>
              {agent.description ? (
                <span className="truncate text-xs text-muted-foreground">{agent.description}</span>
              ) : null}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

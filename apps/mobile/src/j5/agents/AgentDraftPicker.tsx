import { agentPersonaMentionItems } from "@t3tools/client-runtime/j5/agent-mentions";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { useEnvironmentQuery } from "../../state/query";
import { selectDraftAgent } from "./agentDraftState";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/** "Start as agent" for a new-task draft; lists launchable agents only. */
export function AgentDraftPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
  readonly disabled?: boolean;
}) {
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const agents = agentPersonaMentionItems(catalog.data ?? null, "");
  if (agents.length === 0) return null;
  return (
    <View pointerEvents={props.disabled ? "none" : "auto"}>
      <ControlPillMenu
        actions={agents.map((agent) => ({
          id: `agent:${agent.personaId}`,
          title: agent.label,
          subtitle: agent.description,
          attributes: { disabled: props.disabled === true },
        }))}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event.startsWith("agent:"))
            selectDraftAgent(props.draftKey, nativeEvent.event.slice("agent:".length));
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start this task as a saved agent"
          accessibilityState={{ disabled: props.disabled === true }}
          disabled={props.disabled}
          className="h-9 flex-row items-center gap-1.5 rounded-full border border-border px-3 disabled:opacity-40"
        >
          <SymbolView
            name="person.crop.circle"
            size={14}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
          <Text className="text-sm text-foreground">Agent</Text>
        </Pressable>
      </ControlPillMenu>
    </View>
  );
}

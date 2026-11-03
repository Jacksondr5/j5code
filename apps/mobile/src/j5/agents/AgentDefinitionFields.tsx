import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_PERSONA_POLICY_OPTIONS,
  agentPersonaModelChoiceId,
  nextAgentPersonaModelChoice,
  agentPersonaEntryReasoning,
  withAgentPersonaReasoning,
  agentPersonaModelChoices,
  agentPersonaModelGroups,
  agentPersonaPolicyDrivers,
  agentPersonaPolicyNote,
  agentPersonaEntryDriver,
} from "@t3tools/client-runtime/j5/agent-personas";
import type { AgentPersonaAccess, AgentPersonaModelEntry, EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

export interface AgentRoutePolicyValue {
  readonly access: AgentPersonaAccess;
  readonly modelRoute: ReadonlyArray<AgentPersonaModelEntry>;
}

/** Access level and ordered model entries, shared by the create and edit modals. */
export function AgentRoutePolicyFields(props: {
  environmentId: EnvironmentId;
  value: AgentRoutePolicyValue;
  retainRoute?: ReadonlyArray<AgentPersonaModelEntry>;
  disabled: boolean;
  onChange: (next: AgentRoutePolicyValue) => void;
}) {
  const { value, disabled } = props;
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const choices = agentPersonaModelChoices(providers ?? [], [
    ...(props.retainRoute ?? []),
    ...value.modelRoute,
  ]);
  const modelGroups = agentPersonaModelGroups(choices);
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const drivers = agentPersonaPolicyDrivers(catalog.data, value.access);
  const policyNote = agentPersonaPolicyNote(
    drivers,
    value.modelRoute,
    value.access,
    providers ?? [],
  );
  return (
    <>
      <View className="gap-2">
        <Text className="text-sm font-t3-medium">Access level</Text>
        <View pointerEvents={disabled ? "none" : "auto"}>
          <Menu
            actions={AGENT_PERSONA_POLICY_OPTIONS.map((policy) => ({
              id: policy.value,
              title: policy.label,
              state: policy.value === value.access ? "on" : "off",
            }))}
            onPressAction={({ nativeEvent }) => {
              const policy = AGENT_PERSONA_POLICY_OPTIONS.find(
                (item) => item.value === nativeEvent.event,
              );
              if (policy) props.onChange({ ...value, access: policy.value });
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Access level"
              accessibilityState={{ disabled }}
              disabled={disabled}
              className="rounded-xl border border-border px-3 py-3"
            >
              <Text numberOfLines={1}>
                {AGENT_PERSONA_POLICY_OPTIONS.find((item) => item.value === value.access)?.label ??
                  value.access}
              </Text>
            </Pressable>
          </Menu>
        </View>
      </View>
      {policyNote === null ? null : (
        <Text className="text-xs text-foreground-muted">{policyNote}</Text>
      )}
      {value.modelRoute.map((target, index) => {
        const label = `Model ${index + 1}`;
        const effort = agentPersonaEntryReasoning(target);
        const driver = agentPersonaEntryDriver(target, providers ?? []);
        const unsupported = drivers && driver && !drivers.includes(driver);
        const selected = choices.find(({ id }) => id === agentPersonaModelChoiceId(target));
        const reasoningDisabled = disabled || !selected?.efforts.length;
        const updateTarget = (next: AgentPersonaModelEntry) =>
          props.onChange({
            ...value,
            modelRoute: value.modelRoute.map((entry, entryIndex) =>
              entryIndex === index ? next : entry,
            ),
          });
        const moveEntry = (offset: number) => {
          const next = [...value.modelRoute];
          const destination = index + offset;
          if (disabled || destination < 0 || destination >= next.length) return;
          [next[index], next[destination]] = [next[destination]!, next[index]!];
          props.onChange({ ...value, modelRoute: next });
        };
        return (
          <View key={label} className="gap-3 rounded-xl border border-border p-3">
            <View className="flex-row items-start gap-2">
              <View className="min-w-0 flex-1 gap-2">
                <Text className="text-sm font-t3-medium">{label}</Text>
                <Menu
                  actions={modelGroups.map((harness) => ({
                    id: harness.driver,
                    title: harness.label,
                    attributes: {
                      disabled: disabled || harness.models.length === 0,
                    },
                    subactions: harness.models.map(({ id, modelLabel }) => ({
                      id,
                      title: modelLabel,
                      state: id === agentPersonaModelChoiceId(target) ? "on" : "off",
                      attributes: { disabled },
                    })),
                  }))}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === agentPersonaModelChoiceId(target)) return;
                    const choice = choices.find(({ id }) => id === nativeEvent.event);
                    if (!disabled && choice?.available)
                      updateTarget(
                        typeof effort === "string" && choice.efforts.includes(effort)
                          ? withAgentPersonaReasoning(
                              choice.target,
                              effort,
                              choice.reasoningOptionId,
                            )
                          : choice.target,
                      );
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    disabled={disabled}
                    className="rounded-xl border border-border px-3 py-3"
                  >
                    <Text numberOfLines={1}>{selected?.label}</Text>
                  </Pressable>
                </Menu>
              </View>
              <View className="w-28">
                <View className="gap-2">
                  <Text className="text-sm font-t3-medium">Reasoning</Text>
                  <View pointerEvents={reasoningDisabled ? "none" : "auto"}>
                    <Menu
                      actions={(selected?.efforts ?? []).map((effort) => ({
                        id: effort,
                        title: effort,
                        state: effort === agentPersonaEntryReasoning(target) ? "on" : "off",
                      }))}
                      onPressAction={({ nativeEvent }) =>
                        !reasoningDisabled &&
                        selected?.efforts.includes(nativeEvent.event) &&
                        updateTarget(
                          withAgentPersonaReasoning(
                            target,
                            nativeEvent.event,
                            selected.reasoningOptionId,
                          ),
                        )
                      }
                    >
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${label} reasoning`}
                        accessibilityState={{ disabled: reasoningDisabled }}
                        disabled={reasoningDisabled}
                        className="rounded-xl border border-border px-3 py-3"
                      >
                        <Text numberOfLines={1}>{effort ?? "Default"}</Text>
                      </Pressable>
                    </Menu>
                  </View>
                </View>
              </View>
            </View>
            {unsupported ? (
              <Text className="text-xs text-foreground-muted">
                This provider cannot enforce {value.access}.
              </Text>
            ) : null}
            <View className="flex-row gap-4">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Move ${label} up`}
                disabled={disabled || index === 0}
                onPress={() => moveEntry(-1)}
              >
                <Text className={disabled || index === 0 ? "text-foreground-muted" : undefined}>
                  Up
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Move ${label} down`}
                disabled={disabled || index === value.modelRoute.length - 1}
                onPress={() => moveEntry(1)}
              >
                <Text
                  className={
                    disabled || index === value.modelRoute.length - 1
                      ? "text-foreground-muted"
                      : undefined
                  }
                >
                  Down
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${label}`}
                disabled={disabled || value.modelRoute.length === 1}
                onPress={() =>
                  props.onChange({
                    ...value,
                    modelRoute: value.modelRoute.filter((_, i) => i !== index),
                  })
                }
              >
                <Text
                  className={
                    disabled || value.modelRoute.length === 1 ? "text-foreground-muted" : undefined
                  }
                >
                  Remove
                </Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      <Pressable
        accessibilityRole="button"
        disabled={disabled || !nextAgentPersonaModelChoice(choices, value.modelRoute)}
        onPress={() => {
          const choice = nextAgentPersonaModelChoice(choices, value.modelRoute);
          if (choice)
            props.onChange({ ...value, modelRoute: [...value.modelRoute, choice.target] });
        }}
      >
        <Text
          className={
            disabled || !nextAgentPersonaModelChoice(choices, value.modelRoute)
              ? "text-foreground-muted"
              : undefined
          }
        >
          Add model
        </Text>
      </Pressable>
      <Text className="text-xs text-foreground-muted">
        Model availability and access level support are checked for each launch.
      </Text>
    </>
  );
}

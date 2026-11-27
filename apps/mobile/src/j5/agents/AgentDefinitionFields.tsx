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
import { View } from "react-native";

import { IconButton } from "../../components/ui/IconButton";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../features/settings/components/SettingsSwitchRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { FormSelectRow } from "./PersonaFormRows";

export interface AgentRoutePolicyValue {
  readonly access: AgentPersonaAccess;
  readonly modelRoute: ReadonlyArray<AgentPersonaModelEntry>;
  readonly independentReviewer?: boolean | undefined;
}

/** Access level, ordered model entries and the reviewer flag, shared by the create and edit forms. */
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
  const nextChoice = nextAgentPersonaModelChoice(choices, value.modelRoute, drivers);
  return (
    <>
      <SettingsSection title="Access" footer={policyNote ?? undefined}>
        <FormSelectRow
          label="Access level"
          value={
            AGENT_PERSONA_POLICY_OPTIONS.find((item) => item.value === value.access)?.label ??
            value.access
          }
          disabled={disabled}
          actions={AGENT_PERSONA_POLICY_OPTIONS.map((policy) => ({
            id: policy.value,
            title: policy.label,
            state: policy.value === value.access ? "on" : "off",
          }))}
          onSelect={(id) => {
            const policy = AGENT_PERSONA_POLICY_OPTIONS.find((item) => item.value === id);
            if (policy) props.onChange({ ...value, access: policy.value });
          }}
        />
      </SettingsSection>
      {value.modelRoute.map((target, index) => {
        const label = `Model ${index + 1}`;
        const effort = agentPersonaEntryReasoning(target);
        const driver = agentPersonaEntryDriver(target, providers ?? []);
        const unsupported = drivers && driver && !drivers.includes(driver);
        const selected = choices.find(({ id }) => id === agentPersonaModelChoiceId(target));
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
          <SettingsSection
            key={label}
            title={label}
            footer={unsupported ? `This provider cannot enforce ${value.access}.` : undefined}
            trailing={
              value.modelRoute.length > 1 ? (
                <ModelEntryButtons
                  label={label}
                  first={index === 0}
                  last={index === value.modelRoute.length - 1}
                  disabled={disabled}
                  onMove={moveEntry}
                  onRemove={() =>
                    props.onChange({
                      ...value,
                      modelRoute: value.modelRoute.filter((_, i) => i !== index),
                    })
                  }
                />
              ) : undefined
            }
          >
            <FormSelectRow
              label="Model"
              value={selected?.label ?? "Choose a model"}
              disabled={disabled}
              actions={modelGroups.map((harness) => ({
                id: harness.driver,
                title: harness.label,
                // iOS shows each provider as a section, avoiding the submenu transition.
                displayInline: true,
                attributes: { disabled: harness.models.length === 0 },
                subactions: harness.models.map(({ id, modelLabel }) => ({
                  id,
                  title: modelLabel,
                  state: id === agentPersonaModelChoiceId(target) ? "on" : "off",
                })),
              }))}
              onSelect={(id) => {
                if (id === agentPersonaModelChoiceId(target)) return;
                const choice = choices.find((candidate) => candidate.id === id);
                if (!disabled && choice?.available)
                  updateTarget(
                    typeof effort === "string" && choice.efforts.includes(effort)
                      ? withAgentPersonaReasoning(choice.target, effort, choice.reasoningOptionId)
                      : choice.target,
                  );
              }}
            />
            <FormSelectRow
              label="Reasoning"
              value={typeof effort === "string" ? effort : "Default"}
              borderTop
              disabled={disabled || !selected?.efforts.length}
              actions={(selected?.efforts ?? []).map((option) => ({
                id: option,
                title: option,
                state: option === effort ? "on" : "off",
              }))}
              onSelect={(id) => {
                if (selected?.efforts.includes(id))
                  updateTarget(withAgentPersonaReasoning(target, id, selected.reasoningOptionId));
              }}
            />
          </SettingsSection>
        );
      })}
      <SettingsSection footer="Model availability and access level support are checked for each launch.">
        <ListActionRow
          icon="plus"
          label="Add model"
          disabled={disabled || !nextChoice}
          onPress={() => {
            if (nextChoice)
              props.onChange({ ...value, modelRoute: [...value.modelRoute, nextChoice.target] });
          }}
        />
      </SettingsSection>
      <SettingsSection>
        <SettingsSwitchRow
          label="Independent reviewer"
          subtitle="Prefers a model that didn't write the work it reviews. Never blocks a launch."
          value={value.independentReviewer === true}
          disabled={disabled}
          onValueChange={(independentReviewer) => props.onChange({ ...value, independentReviewer })}
        />
      </SettingsSection>
    </>
  );
}

/** Move up, Move down and Remove for one model entry, beside its section title. */
function ModelEntryButtons(props: {
  readonly label: string;
  readonly first: boolean;
  readonly last: boolean;
  readonly disabled: boolean;
  readonly onMove: (offset: number) => void;
  readonly onRemove: () => void;
}) {
  return (
    <View className="flex-row items-center">
      <IconButton
        icon="arrow.up"
        accessibilityLabel={`Move ${props.label} up`}
        disabled={props.disabled || props.first}
        onPress={() => props.onMove(-1)}
      />
      <IconButton
        icon="arrow.down"
        accessibilityLabel={`Move ${props.label} down`}
        disabled={props.disabled || props.last}
        onPress={() => props.onMove(1)}
      />
      <IconButton
        icon="trash"
        accessibilityLabel={`Remove ${props.label}`}
        tintColorClassName="accent-danger-foreground"
        disabled={props.disabled}
        onPress={props.onRemove}
      />
    </View>
  );
}

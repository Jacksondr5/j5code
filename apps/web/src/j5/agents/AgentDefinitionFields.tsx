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
} from "@t3tools/client-runtime/j5/agent-personas";
import type {
  AgentPersonaAuthorityPolicy,
  AgentPersonaModelEntry,
  EnvironmentId,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

export interface AgentRoutePolicyValue {
  readonly authorityPolicy: AgentPersonaAuthorityPolicy;
  readonly modelRoute: ReadonlyArray<AgentPersonaModelEntry>;
}

/** Runtime policy and ordered model entries, shared by the create and edit dialogs. */
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
  const policyNote = agentPersonaPolicyNote(
    agentPersonaPolicyDrivers(catalog.data, value.authorityPolicy),
    value.modelRoute,
    value.authorityPolicy,
    providers ?? [],
  );
  return (
    <>
      <div className="grid gap-1.5 text-sm">
        <span>Runtime policy</span>
        <Select
          value={value.authorityPolicy}
          disabled={disabled}
          onValueChange={(next) => {
            const policy = AGENT_PERSONA_POLICY_OPTIONS.find((item) => item.value === next);
            if (policy) props.onChange({ ...value, authorityPolicy: policy.value });
          }}
        >
          <SelectTrigger aria-label="Runtime policy">
            <SelectValue>
              {
                AGENT_PERSONA_POLICY_OPTIONS.find((item) => item.value === value.authorityPolicy)
                  ?.label
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {AGENT_PERSONA_POLICY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {policyNote === null ? null : (
          <span className="text-xs text-muted-foreground">{policyNote}</span>
        )}
      </div>
      {value.modelRoute.map((target, index) => {
        const label = `Model ${index + 1}`;
        const effort = agentPersonaEntryReasoning(target);
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
          <div key={label} className="grid gap-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{label}</span>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled || index === 0}
                  aria-label={`Move ${label} up`}
                  onClick={() => moveEntry(-1)}
                >
                  Up
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled || index === value.modelRoute.length - 1}
                  aria-label={`Move ${label} down`}
                  onClick={() => moveEntry(1)}
                >
                  Down
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled || value.modelRoute.length === 1}
                  aria-label={`Remove ${label}`}
                  onClick={() =>
                    props.onChange({
                      ...value,
                      modelRoute: value.modelRoute.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2">
              <Menu>
                <MenuTrigger
                  disabled={disabled}
                  aria-label={label}
                  render={
                    <Button type="button" variant="outline" className="w-full justify-between" />
                  }
                >
                  <span className="truncate">{selected?.label}</span>
                  <ChevronDownIcon className="size-4 shrink-0" />
                </MenuTrigger>
                <MenuPopup align="start">
                  {modelGroups.length === 0 ? (
                    <MenuItem disabled>No signed-in providers available</MenuItem>
                  ) : null}
                  {modelGroups.map((harness) => (
                    <MenuSub key={harness.driver}>
                      <MenuSubTrigger disabled={harness.models.length === 0}>
                        {harness.label}
                      </MenuSubTrigger>
                      <MenuSubPopup>
                        <MenuRadioGroup
                          value={agentPersonaModelChoiceId(target)}
                          onValueChange={(next) => {
                            if (next === agentPersonaModelChoiceId(target)) return;
                            const choice = harness.models.find(({ id }) => id === next);
                            if (choice?.available)
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
                          {harness.models.map(({ id, modelLabel }) => (
                            <MenuRadioItem
                              key={id}
                              value={id}
                              // Base UI radio items stay open by default; a model pick is a one-shot choice.
                              closeOnClick
                            >
                              {modelLabel}
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      </MenuSubPopup>
                    </MenuSub>
                  ))}
                </MenuPopup>
              </Menu>
              <Select
                value={typeof effort === "string" ? effort : null}
                disabled={disabled || !selected?.efforts.length}
                onValueChange={(next) => {
                  if (next && selected?.efforts.includes(next))
                    updateTarget(
                      withAgentPersonaReasoning(target, next, selected.reasoningOptionId),
                    );
                }}
              >
                <SelectTrigger className="min-w-0 w-full" aria-label={`${label} reasoning`}>
                  <SelectValue>{effort ?? "Default"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {selected?.efforts.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {effort}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        disabled={disabled || !nextAgentPersonaModelChoice(choices, value.modelRoute)}
        onClick={() => {
          const choice = nextAgentPersonaModelChoice(choices, value.modelRoute);
          if (choice)
            props.onChange({ ...value, modelRoute: [...value.modelRoute, choice.target] });
        }}
      >
        Add model
      </Button>
      <p className="text-xs text-muted-foreground">
        Model availability and runtime policy support are checked for each launch.
      </p>
    </>
  );
}

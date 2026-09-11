import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_PERSONA_HARNESSES,
  AGENT_PERSONA_POLICY_OPTIONS,
  agentPersonaModelChoiceId,
  agentPersonaModelChoices,
} from "@t3tools/client-runtime/j5/agent-personas";
import type {
  AgentPersonaAuthorityPolicy,
  AgentPersonaModelTarget,
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
import { serverEnvironment } from "../../state/server";

export interface AgentRoutePolicyValue {
  readonly authorityPolicy: AgentPersonaAuthorityPolicy;
  readonly modelRoute: readonly [AgentPersonaModelTarget, AgentPersonaModelTarget];
}

/** Runtime policy plus primary/fallback route pickers, shared by the create and edit dialogs. */
export function AgentRoutePolicyFields(props: {
  environmentId: EnvironmentId;
  value: AgentRoutePolicyValue;
  retainRoute?: ReadonlyArray<AgentPersonaModelTarget>;
  disabled: boolean;
  onChange: (next: AgentRoutePolicyValue) => void;
}) {
  const { value, disabled } = props;
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const choices = agentPersonaModelChoices(providers ?? [], [
    ...(props.retainRoute ?? []),
    ...value.modelRoute,
  ]);
  const modelGroups = AGENT_PERSONA_HARNESSES.map((harness) => ({
    ...harness,
    models: choices.filter(
      ({ target, available }) => available && target.driver === harness.driver,
    ),
  })).filter(({ models }) => models.length > 0);
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
      </div>
      {value.modelRoute.map((target, index) => {
        const label = index === 0 ? "Primary model" : "Fallback model";
        const selected = choices.find(({ id }) => id === agentPersonaModelChoiceId(target));
        const updateTarget = (next: AgentPersonaModelTarget) =>
          props.onChange({
            ...value,
            modelRoute: index === 0 ? [next, value.modelRoute[1]] : [value.modelRoute[0], next],
          });
        return (
          <div key={label} className="grid gap-2 rounded-lg border p-3">
            <span className="text-sm font-medium">{label}</span>
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
                      <MenuSubTrigger
                        disabled={!harness.models.some(({ efforts }) => efforts.length > 0)}
                      >
                        {harness.label}
                      </MenuSubTrigger>
                      <MenuSubPopup>
                        <MenuRadioGroup
                          value={agentPersonaModelChoiceId(target)}
                          onValueChange={(next) => {
                            const choice = harness.models.find(({ id }) => id === next);
                            if (choice && choice.efforts.length > 0)
                              updateTarget({
                                ...choice.target,
                                reasoningEffort: choice.efforts.includes(target.reasoningEffort)
                                  ? target.reasoningEffort
                                  : choice.target.reasoningEffort,
                              });
                          }}
                        >
                          {harness.models.map(({ id, modelLabel, efforts }) => (
                            <MenuRadioItem key={id} value={id} disabled={efforts.length === 0}>
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
                value={target.reasoningEffort}
                disabled={disabled || !selected?.efforts.length}
                onValueChange={(next) => {
                  if (next && selected?.efforts.includes(next))
                    updateTarget({ ...target, reasoningEffort: next });
                }}
              >
                <SelectTrigger className="min-w-0 w-full" aria-label={`${label} reasoning`}>
                  <SelectValue>{target.reasoningEffort}</SelectValue>
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
      <p className="text-xs text-muted-foreground">
        Model availability and runtime policy support are checked for each launch.
      </p>
    </>
  );
}

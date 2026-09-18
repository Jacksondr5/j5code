import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";

import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { serverEnvironment } from "../../state/server";
import { CUSTOM_AGENT, describeSeatAgent } from "./crewProposalDraft";
import {
  CREW_ACCESS_OPTIONS,
  chooseCrewSeatPersona,
  crewModelSelection,
  crewReasoningDescriptor,
  resolvedCustomDraft,
  setCrewReasoning,
  type CrewSeatDraft,
} from "./crewSeatRuntime";

interface CrewSeatEditorProps {
  readonly value: CrewSeatDraft;
  readonly environmentId: EnvironmentId | null;
  readonly agents: ReadonlyArray<{ readonly personaId: string; readonly displayName: string }>;
  readonly runtime?: CrewProposalSeatRuntime | undefined;
  readonly disabled: boolean;
  readonly existing?: boolean;
  readonly onChange: (value: CrewSeatDraft) => void;
}

/** The same member and runtime controls are used for proposed seats and manual additions. */
export function CrewSeatEditor(props: CrewSeatEditorProps) {
  const { value, disabled } = props;
  const custom = value.agentId === CUSTOM_AGENT;
  const changeInstructions = (instructions: string) =>
    props.onChange({
      ...(custom ? resolvedCustomDraft(value, props.runtime) : value),
      instructions,
    });
  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          Seat name
          <Input
            aria-label={props.existing ? `${value.seat} seat name` : "New seat name"}
            value={value.seat}
            disabled={disabled || props.existing}
            placeholder="reviewer"
            onChange={(event) => props.onChange({ ...value, seat: event.currentTarget.value })}
          />
        </label>
        <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          <span>Member</span>
          <Select
            value={value.agentId || null}
            disabled={disabled}
            onValueChange={(agentId) => {
              if (agentId) props.onChange(chooseCrewSeatPersona(value, agentId));
            }}
          >
            <SelectTrigger aria-label={`${value.seat || "New seat"} member`}>
              <SelectValue>
                {custom ? "Custom crew member" : describeSeatAgent(props.agents, value.agentId)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem value={CUSTOM_AGENT}>Custom crew member</SelectItem>
              {props.agents.map((agent) => (
                <SelectItem key={agent.personaId} value={agent.personaId}>
                  {agent.displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      {custom ? (
        props.environmentId === null ? (
          <p className="text-xs text-muted-foreground">
            Connect to the crew’s environment to choose its runtime.
          </p>
        ) : (
          <CrewSeatRuntimeFields {...props} environmentId={props.environmentId} />
        )
      ) : (
        <div className="grid gap-2">
          <p className="text-xs text-muted-foreground">Uses the saved persona’s configuration.</p>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(
              [
                ["Harness", props.runtime?.harness],
                ["Model", props.runtime?.model],
                ["Reasoning", props.runtime?.reasoning],
                ["Access", props.runtime?.access],
              ] as const
            ).map(([label, text]) => (
              <div key={label} className="min-w-0 text-xs">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-words text-foreground">
                  {text ?? (props.existing ? "Awaiting preview" : "Shown after adding")}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <label className="grid gap-1 text-xs text-muted-foreground">
        Instructions
        <Textarea
          aria-label={`${value.seat || "New seat"} instructions`}
          className="min-h-20 text-sm"
          value={value.instructions}
          disabled={disabled}
          placeholder={
            custom
              ? "What this crew member should do"
              : "Additional instructions for this seat (optional)"
          }
          onChange={(event) => changeInstructions(event.currentTarget.value)}
        />
      </label>
    </div>
  );
}

function CrewSeatRuntimeFields(props: CrewSeatEditorProps & { environmentId: EnvironmentId }) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? [];
  const choices = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      provider.availability !== "unavailable" &&
      provider.models.length > 0,
  );
  const value = resolvedCustomDraft(props.value, props.runtime);
  const selection = value.modelSelection;
  const provider = providers.find(({ instanceId }) => instanceId === selection?.instanceId);
  const model = provider?.models.find(({ slug }) => slug === selection?.model);
  const reasoning = crewReasoningDescriptor(model);
  const reasoningValue =
    selection?.options?.find(({ id }) => id === reasoning?.id)?.value ??
    getProviderOptionCurrentValue(reasoning);
  const reasoningChoices =
    reasoning?.type === "select"
      ? reasoning.options
      : reasoning?.type === "boolean"
        ? [
            { id: "true", label: "On" },
            { id: "false", label: "Off" },
          ]
        : [];
  const mode = CREW_ACCESS_OPTIONS.find(({ value: mode }) => mode === value.runtimeMode);
  const accessOptions =
    provider?.driver === "acpRegistry"
      ? CREW_ACCESS_OPTIONS.filter(
          ({ value }) => value === "approval-required" || value === "full-access",
        )
      : CREW_ACCESS_OPTIONS;
  const label = props.value.seat || "New seat";
  const providerName = provider
    ? (provider.displayName ?? formatProviderDriverKindLabel(provider.driver))
    : (props.runtime?.harness ?? selection?.instanceId);
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
        <span>Harness</span>
        <Select
          value={selection?.instanceId ?? null}
          disabled={props.disabled || choices.length === 0}
          onValueChange={(instanceId) => {
            const next = choices.find((candidate) => candidate.instanceId === instanceId);
            const nextModel =
              next?.models.find((candidate) => candidate.isDefault) ?? next?.models[0];
            if (next && nextModel)
              props.onChange({ ...value, modelSelection: crewModelSelection(next, nextModel) });
          }}
        >
          <SelectTrigger aria-label={`${label} harness`}>
            <SelectValue>
              {providerName ??
                (choices.length === 0 ? "No available harnesses" : "Use Captain’s harness")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {choices.map((candidate) => (
              <SelectItem key={candidate.instanceId} value={candidate.instanceId}>
                {candidate.displayName ?? formatProviderDriverKindLabel(candidate.driver)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
        <span>Model</span>
        <Select
          value={selection?.model ?? null}
          disabled={props.disabled || !provider?.models.length}
          onValueChange={(slug) => {
            const next = provider?.models.find((candidate) => candidate.slug === slug);
            if (provider && next)
              props.onChange({ ...value, modelSelection: crewModelSelection(provider, next) });
          }}
        >
          <SelectTrigger aria-label={`${label} model`}>
            <SelectValue>{model?.name ?? selection?.model ?? "Use Captain’s model"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {provider?.models.map((candidate) => (
              <SelectItem key={candidate.slug} value={candidate.slug}>
                {candidate.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
        <span>Reasoning</span>
        <Select
          value={reasoningValue === undefined ? null : String(reasoningValue)}
          disabled={props.disabled || !selection || reasoningChoices.length === 0}
          onValueChange={(next) => {
            if (selection && reasoning && next && reasoningChoices.some(({ id }) => id === next))
              props.onChange({
                ...value,
                modelSelection: setCrewReasoning(
                  selection,
                  reasoning,
                  reasoning.type === "boolean" ? next === "true" : next,
                ),
              });
          }}
        >
          <SelectTrigger aria-label={`${label} reasoning`}>
            <SelectValue>
              {reasoningChoices.find(({ id }) => id === String(reasoningValue))?.label ??
                props.runtime?.reasoning ??
                (selection ? "Provider default" : "Use Captain’s reasoning")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {reasoningChoices.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
        <span>Access</span>
        <Select
          value={value.runtimeMode ?? null}
          disabled={props.disabled}
          onValueChange={(next) => {
            const option = accessOptions.find(({ value }) => value === next);
            if (option) props.onChange({ ...value, runtimeMode: option.value });
          }}
        >
          <SelectTrigger aria-label={`${label} access`}>
            <SelectValue>{mode?.label ?? "Use Captain’s access"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {accessOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="grid gap-0.5">
                  <span>{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}

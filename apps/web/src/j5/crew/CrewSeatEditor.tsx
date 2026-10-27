import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalSeatRuntime, CrewWorkspaceOptions } from "@t3tools/contracts/j5";
import { useMemo } from "react";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";

import { Input } from "../../components/ui/input";
import { WorktreeBaseBranchPicker } from "../../components/WorktreeBaseBranchPicker";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { CUSTOM_AGENT, describeSeatAgent } from "./crewProposalDraft";
import {
  CREW_ACCESS_OPTIONS,
  CREW_WORKSPACE_OPTIONS,
  chooseCrewSeatWorkspace,
  setCrewSeatBaseRef,
  setCrewSeatStartFromOrigin,
  setCrewSeatWorktree,
  chooseCrewHarness,
  crewReasoningDescriptor,
  resolvedCrewSeatDraft,
  setCrewReasoning,
  type CrewSeatDraft,
} from "./crewSeatRuntime";

interface CrewSeatEditorProps {
  readonly value: CrewSeatDraft;
  readonly environmentId: EnvironmentId | null;
  readonly agents: ReadonlyArray<{ readonly personaId: string; readonly displayName: string }>;
  readonly runtime?: CrewProposalSeatRuntime | undefined;
  /** What the Captain's repository offers a seat's workspace, from the latest preview. */
  readonly workspaceOptions?: CrewWorkspaceOptions | undefined;
  readonly disabled: boolean;
  readonly loadingInstructions?: boolean;
  readonly onPersonaChange: (personaId: string) => void;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly onChange: (value: CrewSeatDraft) => void;
}

/** The same member and runtime controls are used for proposed seats and manual additions. */
export function CrewSeatEditor(props: CrewSeatEditorProps) {
  const { value, disabled } = props;
  const custom = value.agentId === CUSTOM_AGENT;
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          Name
          <Input
            aria-label="Member name"
            autoFocus
            value={value.seat}
            disabled={disabled}
            placeholder="reviewer"
            onChange={(event) => props.onChange({ ...value, seat: event.currentTarget.value })}
          />
        </label>
        <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          <span>Persona</span>
          <Select
            value={value.agentId || null}
            onOpenChange={props.onMenuOpenChange}
            disabled={disabled}
            onValueChange={(personaId) => {
              if (personaId) props.onPersonaChange(personaId);
            }}
          >
            <SelectTrigger aria-label="Member persona">
              <SelectValue>
                {custom ? "Custom member" : describeSeatAgent(props.agents, value.agentId)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem value={CUSTOM_AGENT}>Custom member</SelectItem>
              {props.agents.map((agent) => (
                <SelectItem key={agent.personaId} value={agent.personaId}>
                  {agent.displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Instructions
        <Textarea
          aria-label="Member instructions"
          value={value.instructions}
          disabled={disabled || props.loadingInstructions}
          placeholder="What should this member do?"
          onChange={(event) =>
            props.onChange({ ...value, instructions: event.currentTarget.value })
          }
        />
      </label>
      {!custom ? (
        <p className="text-xs text-muted-foreground">
          The saved persona remains active. Changes here add guidance for this member only.
        </p>
      ) : null}
      {props.environmentId === null ? (
        <p className="text-xs text-muted-foreground">
          Connect to the crew’s environment to choose its runtime.
        </p>
      ) : (
        <CrewSeatRuntimeFields {...props} environmentId={props.environmentId} />
      )}
      <CrewSeatWorkspaceField {...props} />
    </div>
  );
}

/**
 * Where the seat works, with the choices the Captain's repository offers. A server that predates
 * seat workspaces sends no options, and then there is nothing to choose.
 */
function CrewSeatWorkspaceField(props: CrewSeatEditorProps) {
  const workspace = props.value.workspace;
  const options = props.workspaceOptions;
  if (options === undefined) return null;
  const label = props.value.seat || "New seat";
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
        <span>Workspace</span>
        <Select
          value={workspace?.type ?? null}
          onOpenChange={props.onMenuOpenChange}
          disabled={props.disabled}
          onValueChange={(next) => {
            const option = CREW_WORKSPACE_OPTIONS.find(({ value }) => value === next);
            if (option) props.onChange(chooseCrewSeatWorkspace(props.value, option.value, options));
          }}
        >
          <SelectTrigger aria-label={`${label} workspace`}>
            <SelectValue>
              {CREW_WORKSPACE_OPTIONS.find(({ value }) => value === workspace?.type)?.label ??
                "Choose workspace"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {CREW_WORKSPACE_OPTIONS.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.value === "existing_worktree" && !options?.worktrees.length}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {workspace?.type === "worktree" ? (
        <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          <span>Base branch</span>
          {props.environmentId === null ? null : (
            <WorktreeBaseBranchPicker
              id={`${label}-base-branch`}
              environmentId={props.environmentId}
              cwd={options.cwd ?? null}
              value={workspace.baseRef}
              onValueChange={(next) => props.onChange(setCrewSeatBaseRef(props.value, next))}
              startFromOrigin={workspace.startFromOrigin ?? false}
              onStartFromOriginChange={(checked) =>
                props.onChange(setCrewSeatStartFromOrigin(props.value, checked))
              }
              disabled={props.disabled}
            />
          )}
        </div>
      ) : null}
      {workspace?.type === "existing_worktree" ? (
        <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          <span>Worktree</span>
          <Select
            value={workspace.worktreePath || null}
            onOpenChange={props.onMenuOpenChange}
            disabled={props.disabled || !options?.worktrees.length}
            onValueChange={(next) => {
              if (next) props.onChange(setCrewSeatWorktree(props.value, next));
            }}
          >
            <SelectTrigger aria-label={`${label} worktree`}>
              <SelectValue>
                {options?.worktrees.find(({ path }) => path === workspace.worktreePath)?.branch ??
                  (workspace.worktreePath || "Choose worktree")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {(options?.worktrees ?? []).map((worktree) => (
                <SelectItem key={worktree.path} value={worktree.path}>
                  <span className="grid gap-0.5">
                    <span>{worktree.branch}</span>
                    <span className="text-xs text-muted-foreground">{worktree.path}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

function CrewSeatRuntimeFields(props: CrewSeatEditorProps & { environmentId: EnvironmentId }) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? [];
  const choices = useMemo(
    () =>
      providers.filter(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          provider.status === "ready" &&
          provider.availability !== "unavailable" &&
          provider.models.length > 0,
      ),
    [providers],
  );
  const entries = useMemo(() => deriveProviderInstanceEntries(choices), [choices]);
  const modelOptions = useMemo(
    () => new Map(entries.map((entry) => [entry.instanceId, entry.models])),
    [entries],
  );
  const value = resolvedCrewSeatDraft(props.value, props.runtime);
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
  const activeProvider = selection?.instanceId ?? choices[0]?.instanceId;
  return (
    <div className="flex flex-wrap items-end gap-2">
      {activeProvider ? (
        <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          <span>Model and harness</span>
          <ProviderModelPicker
            environmentId={props.environmentId}
            activeInstanceId={activeProvider}
            model={selection?.model ?? ""}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={modelOptions}
            isComposerOwned={false}
            disabled={props.disabled || choices.length === 0}
            {...(selection ? {} : { triggerLabel: "Choose model" })}
            triggerAriaLabel={`${label} model and harness`}
            onOpenChange={props.onMenuOpenChange}
            onInstanceModelChange={(instanceId, slug) => {
              const nextProvider = choices.find((candidate) => candidate.instanceId === instanceId);
              const nextModel = nextProvider?.models.find((candidate) => candidate.slug === slug);
              if (nextProvider && nextModel)
                props.onChange(chooseCrewHarness(value, nextProvider, nextModel));
            }}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No available harnesses</p>
      )}
      <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
        <span>Reasoning</span>
        <Select
          value={reasoningValue === undefined ? null : String(reasoningValue)}
          onOpenChange={props.onMenuOpenChange}
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
                (selection?.model === props.runtime?.modelSelection.model
                  ? props.runtime?.reasoning
                  : undefined) ??
                (selection ? "Provider default" : "Choose model first")}
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
          value={value.runtimeMode ?? (value.agentId === CUSTOM_AGENT ? null : "persona-default")}
          onOpenChange={props.onMenuOpenChange}
          disabled={props.disabled}
          onValueChange={(next) => {
            if (next === "persona-default") {
              const { runtimeMode: _runtimeMode, ...inherited } = props.value;
              props.onChange(inherited);
              return;
            }
            const option = accessOptions.find(({ value }) => value === next);
            if (option) props.onChange({ ...props.value, runtimeMode: option.value });
          }}
        >
          <SelectTrigger aria-label={`${label} access`}>
            <SelectValue>
              {value.agentId !== CUSTOM_AGENT && props.value.runtimeMode === undefined
                ? (props.runtime?.access ?? "Persona default")
                : (mode?.label ?? props.runtime?.access ?? "Choose access")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {value.agentId !== CUSTOM_AGENT ? (
              <SelectItem value="persona-default">Persona default</SelectItem>
            ) : null}
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

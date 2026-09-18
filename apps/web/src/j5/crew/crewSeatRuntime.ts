import type {
  ModelSelection,
  ProviderOptionDescriptor,
  RuntimeMode,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import type { CrewProposalSeat, CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
import { buildProviderOptionSelectionsFromDescriptors } from "@t3tools/shared/model";

import { CUSTOM_AGENT } from "./crewProposalDraft";

export interface CrewSeatDraft {
  readonly seat: string;
  readonly agentId: string;
  readonly instructions: string;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
}

export const CREW_ACCESS_OPTIONS = [
  {
    value: "approval-required",
    label: "Approval required",
    description: "Ask before commands and file changes.",
  },
  {
    value: "auto-accept-edits",
    label: "Accept edits",
    description: "Approve edits; ask before other actions.",
  },
  {
    value: "auto",
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
  },
  {
    value: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
] as const;

export const crewSeatDraft = (seat: CrewProposalSeat): CrewSeatDraft => ({
  seat: seat.seat,
  agentId: seat.agentId ?? CUSTOM_AGENT,
  instructions: seat.instructions ?? "",
  ...(seat.modelSelection === undefined ? {} : { modelSelection: seat.modelSelection }),
  ...(seat.runtimeMode === undefined ? {} : { runtimeMode: seat.runtimeMode }),
});

/** Freeze the resolved custom runtime before changing one field, so unrelated settings stay put. */
export const resolvedCustomDraft = (
  draft: CrewSeatDraft,
  runtime?: CrewProposalSeatRuntime,
): CrewSeatDraft => {
  const modelSelection = draft.modelSelection ?? runtime?.modelSelection;
  const runtimeMode = draft.runtimeMode ?? runtime?.runtimeMode;
  return {
    ...draft,
    ...(modelSelection ? { modelSelection } : {}),
    ...(runtimeMode ? { runtimeMode } : {}),
  };
};

/** Saved personas own their runtime; custom overrides must not follow a persona selection. */
export const chooseCrewSeatPersona = (draft: CrewSeatDraft, agentId: string): CrewSeatDraft => ({
  seat: draft.seat,
  instructions: draft.instructions,
  agentId,
});

/** A different model starts with its own advertised defaults, never options from another model. */
export const crewModelSelection = (
  provider: Pick<ServerProvider, "instanceId">,
  model: ServerProviderModel,
): ModelSelection => {
  const options = buildProviderOptionSelectionsFromDescriptors(
    model.capabilities?.optionDescriptors,
  );
  return { instanceId: provider.instanceId, model: model.slug, ...(options ? { options } : {}) };
};

/** ACP cannot enforce Auto or Accept edits; a harness switch visibly chooses its supervised mode. */
export const chooseCrewHarness = (
  draft: CrewSeatDraft,
  provider: Pick<ServerProvider, "instanceId" | "driver">,
  model: ServerProviderModel,
): CrewSeatDraft => ({
  ...draft,
  modelSelection: crewModelSelection(provider, model),
  ...(provider.driver === "acpRegistry" &&
  (draft.runtimeMode === "auto" || draft.runtimeMode === "auto-accept-edits")
    ? { runtimeMode: "approval-required" }
    : {}),
});

export const crewReasoningDescriptor = (
  model: ServerProviderModel | undefined,
): ProviderOptionDescriptor | undefined =>
  model?.capabilities?.optionDescriptors?.find(({ id }) =>
    ["reasoningEffort", "effort", "variant", "thinking"].includes(id),
  );

export const setCrewReasoning = (
  selection: ModelSelection,
  descriptor: ProviderOptionDescriptor,
  value: string | boolean,
): ModelSelection => ({
  ...selection,
  options: [
    ...(selection.options ?? []).filter(({ id }) => id !== descriptor.id),
    { id: descriptor.id, value },
  ],
});

export const applyCrewSeatDraft = (
  seat: CrewProposalSeat,
  draft: CrewSeatDraft,
): CrewProposalSeat => ({
  seat: seat.seat,
  reason: seat.reason,
  agentId: draft.agentId === CUSTOM_AGENT ? null : draft.agentId,
  ...(draft.instructions ? { instructions: draft.instructions } : {}),
  ...(draft.agentId === CUSTOM_AGENT && draft.modelSelection
    ? { modelSelection: draft.modelSelection }
    : {}),
  ...(draft.agentId === CUSTOM_AGENT && draft.runtimeMode
    ? { runtimeMode: draft.runtimeMode }
    : {}),
});

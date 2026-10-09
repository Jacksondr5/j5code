// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing for deterministic ids and digests.
import * as NodeCrypto from "node:crypto";
import type {
  ModelSelection,
  OrchestrationV2AgentPersonaAssignment,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
import { isAgentPersonaReasoningOptionId } from "@t3tools/contracts";
import type {
  CrewPersonaSwap,
  CrewProposalPlaybook,
  CrewProposalSeatRuntime,
} from "@t3tools/contracts/j5";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import type { CrewCaptain, ResolvedCrewLaunchSeat } from "./CrewLaunchService.ts";
import type { CrewProposal } from "./AgentCrewProposalService.ts";

/** Make advertised defaults explicit so a later provider default cannot alter an approved launch. */
export function materializeCrewModelSelection(
  selection: ModelSelection,
  provider: ServerProvider,
): ModelSelection {
  const descriptors =
    provider.models.find((model) => model.slug === selection.model)?.capabilities
      ?.optionDescriptors ?? [];
  const options = [...(selection.options ?? [])];
  for (const descriptor of descriptors) {
    if (options.some((option) => option.id === descriptor.id)) continue;
    const value = getProviderOptionCurrentValue(descriptor);
    if (value !== undefined) options.push({ id: descriptor.id, value });
  }
  return options.length === 0 ? selection : { ...selection, options };
}

/** Reject unsupported selections instead of letting a provider silently fall back to a default. */
export function crewModelSelectionProblem(
  selection: ModelSelection,
  provider: ServerProvider,
): string | null {
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (model === undefined)
    return `Provider ${selection.instanceId} does not advertise ${selection.model}.`;
  const seen = new Set<string>();
  for (const option of selection.options ?? []) {
    if (seen.has(option.id)) return `Model ${selection.model} repeats option ${option.id}.`;
    seen.add(option.id);
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === option.id,
    );
    if (descriptor === undefined)
      return `Model ${selection.model} does not advertise option ${option.id}.`;
    if (
      descriptor.type === "boolean"
        ? typeof option.value !== "boolean"
        : typeof option.value !== "string" ||
          !descriptor.options.some((choice) => choice.id === option.value)
    )
      return `Model ${selection.model} does not support ${option.id}=${String(option.value)}.`;
  }
  return null;
}

const harnessName = (driver: string) =>
  ({
    codex: "Codex",
    claudeAgent: "Claude Code",
    cursor: "Cursor",
    grok: "Grok",
    opencode: "OpenCode",
    antigravity: "Antigravity",
  })[driver] ?? driver;

/** Keep the model's declared vendor and distinguish custom provider instances from built-in names. */
const providerName = (provider: ServerProvider, subProvider: string | undefined) => {
  const vendor =
    subProvider ??
    (provider.driver === "codex"
      ? "OpenAI"
      : provider.driver === "claudeAgent"
        ? "Anthropic"
        : undefined);
  if (vendor === undefined) return provider.displayName ?? harnessName(provider.driver);
  const name = provider.displayName;
  const builtInNames = [
    harnessName(provider.driver),
    vendor,
    ...(provider.driver === "claudeAgent" ? ["Claude"] : []),
  ];
  return name === undefined ||
    builtInNames.some((builtIn) => builtIn.toLowerCase() === name.toLowerCase())
    ? vendor
    : `${vendor} (${name})`;
};

export function describeCrewSeatRuntime(
  seat: string,
  selection: ModelSelection,
  provider: ServerProvider,
  mode: RuntimeMode,
  assignment: OrchestrationV2AgentPersonaAssignment | null,
): Omit<CrewProposalSeatRuntime, "workspace"> {
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  const resolved = materializeCrewModelSelection(selection, provider);
  const descriptor = model?.capabilities?.optionDescriptors?.find((option) =>
    isAgentPersonaReasoningOptionId(option.id),
  );
  const effort = resolved.options?.find((option) =>
    descriptor === undefined
      ? isAgentPersonaReasoningOptionId(option.id)
      : option.id === descriptor.id,
  )?.value;
  const reasoning =
    typeof effort === "string"
      ? ((descriptor?.type === "select"
          ? descriptor.options.find((option) => option.id === effort)?.label
          : undefined) ?? effort)
      : typeof effort === "boolean"
        ? effort
          ? "On"
          : "Off"
        : "Provider default";
  const access =
    assignment !== null && assignment.runtimeModeOverride === undefined
      ? mode === "full-access"
        ? "Full access"
        : mode === "approval-required"
          ? "Read only"
          : "Repository write"
      : mode === "full-access"
        ? "Full access"
        : mode === "auto"
          ? "Auto"
          : mode === "auto-accept-edits"
            ? "Auto-accept edits"
            : "Supervised";
  return {
    seat,
    provider: providerName(provider, model?.subProvider),
    harness: harnessName(provider.driver),
    model: model?.name ?? selection.model,
    reasoning,
    access,
    modelSelection: selection,
    runtimeMode: mode,
  };
}

/**
 * A stable hash of the playbook plan the card shows: the definition, each step's title and
 * persona in YAML order, the swaps per seat, and the steps nobody owns. Prompts stay out; they are
 * read live when a step is delivered.
 */
export function crewPlaybookPlanDigest(plan: {
  readonly definitionPath: string;
  readonly summary: CrewProposalPlaybook;
  readonly swapsBySeat: ReadonlyMap<string, ReadonlyArray<CrewPersonaSwap>>;
  readonly unownedSteps: ReadonlyArray<string>;
}): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        definitionPath: plan.definitionPath,
        title: plan.summary.title,
        steps: plan.summary.steps.map(({ id, title, persona }) => [id, title, persona ?? null]),
        swaps: [...plan.swapsBySeat],
        unownedSteps: plan.unownedSteps,
      }),
    )
    .digest("hex");
}

/**
 * Content token survives restarts and binds both the human's roster and the exact launch snapshot.
 * A playbook Crew also binds its plan digest; without one the token is what it always was.
 */
export function crewApprovalToken(
  proposal: CrewProposal,
  captain: CrewCaptain,
  seats: ReadonlyArray<ResolvedCrewLaunchSeat>,
  playbookPlan?: string,
): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        proposalId: proposal.id,
        brief: proposal.brief,
        displayName: proposal.displayName,
        projectId: captain.thread.projectId,
        branch: captain.thread.branch,
        worktreePath: captain.thread.worktreePath,
        interactionMode: captain.thread.interactionMode,
        seats,
        ...(playbookPlan === undefined ? {} : { playbookPlan }),
      }),
    )
    .digest("hex");
}

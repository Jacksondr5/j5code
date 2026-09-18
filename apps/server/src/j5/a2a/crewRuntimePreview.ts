import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import type {
  ModelSelection,
  OrchestrationV2AgentPersonaAssignment,
  OrchestrationV2AppThread,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
import type { CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
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

const harnessName = (driver: string) =>
  ({
    codex: "Codex",
    claudeAgent: "Claude Code",
    cursor: "Cursor",
    grok: "Grok",
    opencode: "OpenCode",
    antigravity: "Antigravity",
  })[driver] ?? driver;

export function describeCrewSeatRuntime(
  seat: string,
  selection: ModelSelection,
  provider: ServerProvider,
  mode: RuntimeMode,
  assignment: OrchestrationV2AgentPersonaAssignment | null,
): CrewProposalSeatRuntime {
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  const resolved = materializeCrewModelSelection(selection, provider);
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (option) => option.id === "reasoningEffort" || option.id === "effort",
  );
  const effort = resolved.options?.find(
    (option) => option.id === "reasoningEffort" || option.id === "effort",
  )?.value;
  const reasoning =
    typeof effort === "string"
      ? ((descriptor?.type === "select"
          ? descriptor.options.find((option) => option.id === effort)?.label
          : undefined) ?? effort)
      : "Provider default";
  const access =
    assignment !== null
      ? mode === "approval-required"
        ? "Read only"
        : "Repository write"
      : mode === "full-access"
        ? "Full access"
        : mode === "auto"
          ? "Auto review"
          : mode === "auto-accept-edits"
            ? "Accept edits"
            : "Approval required";
  return {
    seat,
    provider:
      provider.displayName ??
      model?.subProvider ??
      (provider.driver === "codex"
        ? "OpenAI"
        : provider.driver === "claudeAgent"
          ? "Anthropic"
          : harnessName(provider.driver)),
    harness: harnessName(provider.driver),
    model: model?.name ?? selection.model,
    reasoning,
    access,
  };
}

/** Content token survives restarts and binds both the human's roster and the exact launch snapshot. */
export function crewApprovalToken(
  proposal: CrewProposal,
  captain: CrewCaptain,
  seats: ReadonlyArray<ResolvedCrewLaunchSeat>,
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
      }),
    )
    .digest("hex");
}

/** A deterministic retry must reuse the configuration already written to the seat's thread. */
export function sameCrewRuntime(
  thread: OrchestrationV2AppThread,
  seat: ResolvedCrewLaunchSeat,
): boolean {
  return (
    thread.runtimeMode === seat.runtimeMode &&
    NodeUtil.isDeepStrictEqual(thread.modelSelection, seat.modelSelection) &&
    NodeUtil.isDeepStrictEqual(thread.agentPersonaAssignment ?? null, seat.assignment)
  );
}

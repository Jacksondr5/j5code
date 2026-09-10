import type {
  ActionSummary,
  Artifact,
  ArtifactMetadata,
  RunDetail,
  WorkflowDefinitionPresentation,
} from "@j5/workflow-contracts";

export type Metadata = { commitMessage: string; title: string; body: string };
export type MetadataDraft = Metadata & {
  runId: string;
  gateRevision: number;
  gateHash: string;
  saved: Metadata;
};
export type FeedbackDraft = { runId: string; gateHash: string; text: string };

export const emptyMetadata: Metadata = { commitMessage: "", title: "", body: "" };
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function gateArtifactMetadata(run: RunDetail): readonly ArtifactMetadata[] {
  if (!run.gate) return [];
  const byId = new Map(run.artifacts.map((artifact) => [artifact.id, artifact]));
  return run.gate.artifactIds.flatMap((id) => byId.get(id) ?? []);
}

export function visibleArtifactMetadata(run: RunDetail): readonly ArtifactMetadata[] {
  const result: ArtifactMetadata[] = [];
  const seen = new Set<string>();
  const append = (artifact: ArtifactMetadata | undefined) => {
    if (!artifact || seen.has(artifact.id)) return;
    seen.add(artifact.id);
    result.push(artifact);
  };
  gateArtifactMetadata(run).forEach(append);
  if (run.phase === "publication_approval")
    append(run.artifacts.findLast((artifact) => artifact.phase === "validation"));
  if (run.status === "completed")
    run.artifacts
      .filter((artifact) => ["commit", "push", "draft"].includes(artifact.phase))
      .forEach(append);
  return result;
}

export function splitGateArtifacts(artifacts: readonly Artifact[]) {
  return {
    reviews: artifacts.filter(
      (artifact) => isRecord(artifact.content) && "verdict" in artifact.content,
    ),
    evidence: artifacts.filter(
      (artifact) => !isRecord(artifact.content) || !("verdict" in artifact.content),
    ),
  };
}

export function groupActionsByPhase(actions: readonly ActionSummary[]) {
  const groups: Array<{ phase: string; actions: ActionSummary[] }> = [];
  const byPhase = new Map<string, ActionSummary[]>();
  for (const action of actions) {
    let group = byPhase.get(action.phase);
    if (!group) {
      group = [];
      byPhase.set(action.phase, group);
      groups.push({ phase: action.phase, actions: group });
    }
    group.push(action);
  }
  return groups;
}

export function nonGateArtifacts(run: RunDetail) {
  const gateIds = new Set(run.gate?.artifactIds ?? []);
  return run.artifacts.filter((artifact) => !gateIds.has(artifact.id));
}

export function findDefinition(
  definitions: readonly WorkflowDefinitionPresentation[],
  run: RunDetail,
) {
  return definitions.find(
    (item) =>
      item.id === run.definitionId &&
      item.version === run.definitionVersion &&
      item.hash === run.definitionHash,
  );
}

export function publicationValidationFor(
  run: RunDetail,
  gateArtifacts: readonly Artifact[],
  allArtifacts: readonly Artifact[],
) {
  if (run.phase !== "publication_approval") return undefined;
  const content = gateArtifacts.find((artifact) => artifact.phase === "metadata")?.content;
  const identity =
    isRecord(content) && typeof content.codeIdentity === "string" ? content.codeIdentity : null;
  if (!identity) return undefined;
  return allArtifacts.findLast(
    (artifact) =>
      artifact.phase === "validation" &&
      isRecord(artifact.content) &&
      artifact.content.codeIdentity === identity,
  );
}

export function metadataFrom(artifact: Artifact | undefined): Metadata {
  const content = artifact?.content;
  return isRecord(content)
    ? {
        commitMessage: String(content.commitMessage ?? ""),
        title: String(content.title ?? ""),
        body: String(content.body ?? ""),
      }
    : emptyMetadata;
}

export const sameMetadata = (left: Metadata, right: Metadata) =>
  left.commitMessage === right.commitMessage &&
  left.title === right.title &&
  left.body === right.body;

export function appliedDraftFor(draft: MetadataDraft | null, run: RunDetail) {
  return draft?.runId === run.id &&
    draft.gateRevision === run.gate?.revision &&
    draft.gateHash === run.gate?.artifactHash
    ? draft
    : null;
}

export function appliedFeedbackFor(feedback: FeedbackDraft | null, run: RunDetail) {
  return feedback?.runId === run.id && feedback.gateHash === run.gate?.artifactHash
    ? feedback
    : null;
}

export const hasOpenActions = (actions: readonly ActionSummary[]) =>
  actions.some((action) => ["pending", "claimed", "blocked"].includes(action.status));

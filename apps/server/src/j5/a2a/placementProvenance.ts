import type { OrchestrationV2AppThread } from "@t3tools/contracts";

import type { ParticipantId } from "./contracts.ts";
import type { ParticipantProvenance } from "./placementContracts.ts";

/**
 * Converts immutable upstream lineage into the typed J5 provenance fact.
 * `parentParticipantId` comes from squadron membership; timeline breadcrumbs such
 * as `thread.created.record` are intentionally not consulted.
 */
export function provenanceFromThreadLineage(input: {
  readonly lineage: Pick<
    OrchestrationV2AppThread["lineage"],
    "parentThreadId" | "relationshipToParent"
  >;
  readonly parentParticipantId: ParticipantId | null;
}): ParticipantProvenance {
  if (input.lineage.parentThreadId === null || input.parentParticipantId === null) {
    return { kind: "unknown", source: "native_or_unobserved" };
  }
  switch (input.lineage.relationshipToParent) {
    case "subagent":
      return {
        kind: "spawned-by",
        spawnedByParticipantId: input.parentParticipantId,
        source: "upstream_lineage",
      };
    case "fork":
      return {
        kind: "forked-from",
        sourceParticipantId: input.parentParticipantId,
        source: "upstream_lineage",
      };
    case null:
      return { kind: "unknown", source: "native_or_unobserved" };
  }
}

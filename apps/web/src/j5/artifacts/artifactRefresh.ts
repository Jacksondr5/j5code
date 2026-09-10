import type { ArtifactChangeEvent } from "@t3tools/contracts";

export function nextArtifactRefreshGeneration(
  current: number,
  change: ArtifactChangeEvent | null,
): number {
  return change === null ? current : current + 1;
}

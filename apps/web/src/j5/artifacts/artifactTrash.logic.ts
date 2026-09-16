import type { ArtifactEntry } from "@t3tools/contracts";

export function artifactSelectionAfterTrash(
  entries: ReadonlyArray<ArtifactEntry>,
  trashedPath: string,
): { readonly entries: ReadonlyArray<ArtifactEntry>; readonly selectedPath: string | null } {
  const removedIndex = entries.findIndex((entry) => entry.path === trashedPath);
  const remaining = entries.filter((entry) => entry.path !== trashedPath);
  const fallbackIndex = Math.min(Math.max(removedIndex, 0), remaining.length - 1);
  return {
    entries: remaining,
    selectedPath: remaining[fallbackIndex]?.path ?? null,
  };
}

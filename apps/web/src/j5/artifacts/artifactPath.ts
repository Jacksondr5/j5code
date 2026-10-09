export function artifactPathFromWorkspaceRelativePath(
  workspaceRelativePath: string | null,
): string | null {
  if (workspaceRelativePath === null) return null;
  const normalized = workspaceRelativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized.startsWith("artifacts/")) return null;
  const artifactPath = normalized.slice("artifacts/".length);
  return artifactPath.length > 0 ? artifactPath : null;
}

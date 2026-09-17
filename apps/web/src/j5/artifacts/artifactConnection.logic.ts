export function canFetchArtifacts(input: {
  readonly environmentId: string | null;
  readonly projectId: string | null;
  readonly connected: boolean;
}): boolean {
  return input.environmentId !== null && input.projectId !== null && input.connected;
}

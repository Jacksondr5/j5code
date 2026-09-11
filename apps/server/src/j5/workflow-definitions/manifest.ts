import manifest from "./manifest.json" with { type: "json" };

export const runtimeBuildHash = manifest.hash;

/** Development v3 keeps its reviewed compatibility identity; the manifest build hash is checked separately. */
export function definitionHash(_definitionUrl: string): string {
  return manifest.legacyDefinitionHash;
}

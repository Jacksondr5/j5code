import manifest from "./manifest.json" with { type: "json" };

export const runtimeBuildHash = manifest.hash;
export const definitionHash = runtimeBuildHash;

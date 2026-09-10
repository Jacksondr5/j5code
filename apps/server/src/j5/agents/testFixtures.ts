import { decodeAgentPersonaDefinition } from "./agentPersonas.ts";
// Only routing and permission combinations needed by the tests; no real persona instructions.
const cases = {
  scout: [
    "read-only",
    ["codex", "gpt-5.6-terra", "high"],
    ["claudeAgent", "claude-opus-5", "high"],
  ],
  navigator: [
    "read-only",
    ["codex", "gpt-5.6-sol", "high"],
    ["claudeAgent", "claude-fable-5-1", "high"],
  ],
  advocate: [
    "read-only",
    ["claudeAgent", "claude-sonnet-5", "high"],
    ["codex", "gpt-5.6-terra", "high"],
  ],
  skeptic: [
    "read-only",
    ["claudeAgent", "claude-opus-5", "high"],
    ["codex", "gpt-5.6-terra", "high"],
  ],
  builder: [
    "workspace-write",
    ["codex", "gpt-5.6-sol", "high"],
    ["claudeAgent", "claude-opus-5", "high"],
  ],
  critic: [
    "critic-review",
    ["claudeAgent", "claude-opus-5", "high"],
    ["codex", "gpt-5.6-terra", "high"],
  ],
  sentry: [
    "read-only",
    ["claudeAgent", "claude-fable-5-1", "high"],
    ["codex", "gpt-5.6-terra", "high"],
  ],
  publisher: [
    "publish-only",
    ["codex", "gpt-5.6-terra", "medium"],
    ["claudeAgent", "claude-sonnet-5", "medium"],
  ],
  investigator: [
    "diagnostic",
    ["codex", "gpt-5.6-sol", "high"],
    ["claudeAgent", "claude-fable-5-1", "high"],
  ],
  prosecutor: [
    "read-only",
    ["claudeAgent", "claude-opus-5", "high"],
    ["codex", "gpt-5.6-terra", "high"],
  ],
  herald: [
    "read-only",
    ["codex", "gpt-5.6-terra", "high"],
    ["claudeAgent", "claude-sonnet-5", "high"],
  ],
} as const;
export const TEST_PERSONAS = Object.fromEntries(
  Object.entries(cases).map(([id, [policy, primary, fallback]]) => [
    id,
    decodeAgentPersonaDefinition({
      id,
      version: 1,
      displayName: id,
      description: "Synthetic test persona.",
      acceptedInput: "Test input.",
      inputArtifacts: [],
      outputArtifact: "ContextBrief",
      instructions: "Synthetic test instructions.",
      authority: {
        defaultPolicy: policy,
        allowedPolicies: id === "critic" ? [policy, "critic-fix"] : [policy],
      },
      modelRoute: [primary, fallback].map(([driver, model, reasoningEffort]) => ({
        driver,
        model,
        reasoningEffort,
      })),
    }),
  ]),
) as Record<keyof typeof cases, ReturnType<typeof decodeAgentPersonaDefinition>>;
export const listTestPersonas = () => Object.values(TEST_PERSONAS);

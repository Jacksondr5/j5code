import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { readWorkflowExecution, workflowAuthorities } from "./Execution.ts";
export const testExecution = readWorkflowExecution({
  stateRoot: "/test/workflows",
  personas: Object.fromEntries(
    Object.entries(workflowAuthorities).map(([personaId, authorityPolicy]) => [
      personaId,
      {
        personaId,
        authorityPolicy,
        definitionVersion: 1,
        definitionDigest: "a".repeat(64),
        displayName: personaId,
        resolvedRoute: "primary",
        resolvedDriver: ProviderDriverKind.make("codex"),
        resolvedModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "test-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    ]),
  ),
});

import { TEST_PERSONAS } from "../agents/testFixtures.ts";
export const workflowProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-09T00:00:00.000Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: "test-model",
      name: "Test",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
};
export const definitions = Object.entries(workflowAuthorities).map(([id, authority]) => ({
  ...TEST_PERSONAS.scout,
  id,
  displayName: id,
  instructions: `Original ${id}`,
  authority: { defaultPolicy: authority, allowedPolicies: [authority] },
  modelRoute: [
    { driver: "codex", model: "test-model", reasoningEffort: "high" },
    { driver: "codex", model: "fallback", reasoningEffort: "high" },
  ],
}));

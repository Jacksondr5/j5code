import { TEST_PERSONAS } from "./testFixtures.ts";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  buildAgentPersonaAssignment,
  validateAgentPersonaAssignment,
} from "./agentPersonaAssignment.ts";

const criticRoute = {
  status: "available",
  personaId: "critic",
  definitionVersion: 1,
  route: "primary",
  driver: "claudeAgent",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5",
    options: [{ id: "effort", value: "high" }],
  },
  rejectedTargets: [],
} as const;

describe("agent persona assignment", () => {
  it("snapshots the default authority and resolved route", () => {
    const result = buildAgentPersonaAssignment({
      definition: TEST_PERSONAS.critic,
      resolution: criticRoute,
    });
    assert.equal(result.status, "assigned");
    if (result.status !== "assigned") return;
    assert.deepEqual(result.assignment, {
      personaId: "critic",
      definitionVersion: 1,
      authorityPolicy: "critic-review",
      resolvedRoute: "primary",
      resolvedDriver: ProviderDriverKind.make("claudeAgent"),
      resolvedModelSelection: criticRoute.modelSelection,
    });
  });

  it("blocks Critic Fix Mode on a provider that cannot enforce workspace authority", () => {
    const result = buildAgentPersonaAssignment({
      definition: TEST_PERSONAS.critic,
      resolution: criticRoute,
      authorityPolicy: "critic-fix",
    });
    assert.deepEqual(result, {
      status: "authority-not-enforceable",
      personaId: "critic",
      requestedPolicy: "critic-fix",
      driver: "claudeAgent",
    });
  });

  it("rejects an authority policy outside the persona contract", () => {
    const result = buildAgentPersonaAssignment({
      definition: TEST_PERSONAS.critic,
      resolution: criticRoute,
      authorityPolicy: "workspace-write",
    });
    assert.deepEqual(result, {
      status: "invalid-authority-policy",
      personaId: "critic",
      requestedPolicy: "workspace-write",
      allowedPolicies: ["critic-review", "critic-fix"],
    });
  });

  it("rejects forged assignments that combine a persona with elevated authority", () => {
    assert.equal(
      validateAgentPersonaAssignment(
        {
          personaId: "scout",
          definitionVersion: 1,
          authorityPolicy: "publish-only",
          resolvedRoute: "primary",
          resolvedDriver: ProviderDriverKind.make("codex"),
          resolvedModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-terra",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        },
        TEST_PERSONAS.scout,
      ),
      "Agent persona assignment uses an authority policy outside its definition.",
    );
  });

  it("accepts a server-built assignment that matches the declared route", () => {
    const result = buildAgentPersonaAssignment({
      definition: TEST_PERSONAS.critic,
      resolution: criticRoute,
    });
    assert.equal(result.status, "assigned");
    if (result.status !== "assigned") return;
    assert.isUndefined(validateAgentPersonaAssignment(result.assignment, TEST_PERSONAS.critic));
  });
});

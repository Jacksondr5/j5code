import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { buildBuiltInAgentPersonaAssignment } from "./agentPersonaAssignment.ts";

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
    const result = buildBuiltInAgentPersonaAssignment({ resolution: criticRoute });
    assert.equal(result.status, "assigned");
    if (result.status === "invalid-authority-policy") return;
    assert.deepEqual(result.assignment, {
      personaId: "critic",
      definitionVersion: 1,
      authorityPolicy: "critic-review",
      resolvedRoute: "primary",
      resolvedDriver: ProviderDriverKind.make("claudeAgent"),
      resolvedModelSelection: criticRoute.modelSelection,
    });
  });

  it("accepts Critic Fix Mode only when explicitly requested", () => {
    const result = buildBuiltInAgentPersonaAssignment({
      resolution: criticRoute,
      authorityPolicy: "critic-fix",
    });
    assert.equal(result.status, "assigned");
    if (result.status === "invalid-authority-policy") return;
    assert.equal(result.assignment.authorityPolicy, "critic-fix");
  });

  it("rejects an authority policy outside the persona contract", () => {
    const result = buildBuiltInAgentPersonaAssignment({
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
});

import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  buildAgentPersonaAssignment,
  validateAgentPersonaAssignment,
} from "./agentPersonaAssignment.ts";
import { listBuiltInAgentPersonas } from "./agentPersonas.ts";

const criticRoute = {
  status: "available",
  personaId: "critic",
  definitionVersion: 1,
  route: "primary",
  driver: ProviderDriverKind.make("claudeAgent"),
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5",
    options: [{ id: "effort", value: "high" }],
  },
  rejectedTargets: [],
} as const;

describe("agent persona assignment", () => {
  it("snapshots the default authority and resolved route", () => {
    const result = buildAgentPersonaAssignment({ resolution: criticRoute });
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
      resolution: criticRoute,
      authorityPolicy: "critic-fix",
    });
    assert.deepEqual(result, {
      status: "authority-not-enforceable",
      personaId: "critic",
      requestedPolicy: "critic-fix",
      driver: ProviderDriverKind.make("claudeAgent"),
    });
  });

  it("rejects an authority policy outside the persona contract", () => {
    const result = buildAgentPersonaAssignment({
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
      validateAgentPersonaAssignment({
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
      }),
      "Persona assignment uses an authority policy outside its definition.",
    );
  });

  it("matches the declared reasoning under whichever option id the provider uses", () => {
    const [scout] = listBuiltInAgentPersonas();
    const target = {
      driver: ProviderDriverKind.make("opencode"),
      model: "glm-5",
      reasoningEffort: "high",
    };
    const definition = { ...scout!, modelRoute: [target, target] as const };
    const assignment = (...options: ReadonlyArray<{ id: string; value: string }>) => ({
      personaId: scout!.id,
      definitionVersion: scout!.version,
      authorityPolicy: scout!.authority.defaultPolicy,
      runtimeModeOverride: "full-access" as const,
      resolvedRoute: "primary" as const,
      resolvedDriver: target.driver,
      resolvedModelSelection: {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "glm-5",
        options,
      },
    });
    const mismatch = "Persona assignment does not match its declared model route.";

    assert.isUndefined(
      validateAgentPersonaAssignment(assignment({ id: "variant", value: "high" }), definition),
    );
    assert.equal(
      validateAgentPersonaAssignment(assignment({ id: "fastMode", value: "high" }), definition),
      mismatch,
    );
    // A second reasoning option could be the one the provider honors.
    assert.equal(
      validateAgentPersonaAssignment(
        assignment({ id: "effort", value: "high" }, { id: "reasoningEffort", value: "low" }),
        definition,
      ),
      mismatch,
    );
  });

  it("accepts a server-built assignment that matches the declared route", () => {
    const result = buildAgentPersonaAssignment({ resolution: criticRoute });
    assert.equal(result.status, "assigned");
    if (result.status !== "assigned") return;
    assert.isUndefined(validateAgentPersonaAssignment(result.assignment));
  });

  describe("full-access policy", () => {
    const [scout] = listBuiltInAgentPersonas();
    const fullAccess = {
      ...scout!,
      authority: { defaultPolicy: "full-access", allowedPolicies: ["full-access"] },
    } as const;
    const resolution = (driver: string) =>
      ({
        ...criticRoute,
        personaId: scout!.id,
        driver: ProviderDriverKind.make(driver),
        modelSelection: {
          instanceId: ProviderInstanceId.make(driver),
          model: "any-model",
        },
      }) as const;

    it("assigns a declared full-access policy on Codex, Claude, and Cursor", () => {
      for (const driver of ["codex", "claudeAgent", "cursor"]) {
        const result = buildAgentPersonaAssignment({
          resolution: resolution(driver),
          definition: fullAccess,
        });
        assert.equal(result.status, "assigned");
        if (result.status !== "assigned") return;
        assert.equal(result.assignment.authorityPolicy, "full-access");
      }
    });

    it("rejects it when the persona does not allow full access", () => {
      const result = buildAgentPersonaAssignment({
        resolution: resolution("codex"),
        definition: scout!,
        authorityPolicy: "full-access",
      });
      assert.equal(result.status, "invalid-authority-policy");
    });

    it("blocks it on a driver that cannot honor it", () => {
      const result = buildAgentPersonaAssignment({
        resolution: resolution("unknownDriver"),
        definition: fullAccess,
      });
      assert.equal(result.status, "authority-not-enforceable");
    });
  });
});

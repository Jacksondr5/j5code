import { assert, describe, it } from "@effect/vitest";

import {
  AGENT_AUTHORITY_RULES,
  agentPersonaAccess,
  AGENT_PERSONA_IDS,
  BUILT_IN_AGENT_PERSONAS,
  decodeAgentPersonaDefinition,
  getBuiltInAgentPersona,
  listBuiltInAgentPersonas,
} from "./agentPersonas.ts";

describe("built-in agent persona catalog", () => {
  it("exposes every definition through stable ids", () => {
    assert.deepEqual(Object.keys(BUILT_IN_AGENT_PERSONAS), [...AGENT_PERSONA_IDS]);
    assert.deepEqual(
      listBuiltInAgentPersonas().map(({ id }) => id),
      [...AGENT_PERSONA_IDS],
    );

    for (const id of AGENT_PERSONA_IDS) {
      const definition = getBuiltInAgentPersona(id);
      assert.equal(definition.id, id);
      assert.equal(definition.version, 1);
      assert.lengthOf(definition.modelRoute, 2);
    }
  });

  it("preserves the settled Phase 1 decisions", () => {
    assert.equal(BUILT_IN_AGENT_PERSONAS.skeptic.modelRoute[1].model, "gpt-5.6-terra");
    assert.deepEqual(BUILT_IN_AGENT_PERSONAS.investigator.authority, {
      defaultPolicy: "diagnostic",
      allowedPolicies: ["diagnostic"],
    });
    assert.deepEqual(BUILT_IN_AGENT_PERSONAS.critic.authority, {
      defaultPolicy: "critic-review",
      allowedPolicies: ["critic-review", "critic-fix"],
    });
  });

  it("orders a concrete provider and model before its fallback", () => {
    for (const definition of listBuiltInAgentPersonas()) {
      const [primary, fallback] = definition.modelRoute;
      assert.notDeepEqual(primary, fallback);
      assert.match(primary.model, /^(?:gpt|claude)-/);
      assert.match(fallback.model, /^(?:gpt|claude)-/);
    }
  });

  it("gives Builder a writable workspace and Publisher a publication-only one", () => {
    const builder = AGENT_AUTHORITY_RULES[BUILT_IN_AGENT_PERSONAS.builder.authority.defaultPolicy];
    assert.equal(builder.workspace, "write");
    const publisher =
      AGENT_AUTHORITY_RULES[BUILT_IN_AGENT_PERSONAS.publisher.authority.defaultPolicy];
    assert.equal(publisher.workspace, "publication-only");
  });

  it("allows Critic workspace edits only in explicitly requested Fix Mode", () => {
    assert.equal(AGENT_AUTHORITY_RULES["critic-review"].workspace, "read-only");
    assert.equal(AGENT_AUTHORITY_RULES["critic-fix"].workspace, "write");
    assert.equal(BUILT_IN_AGENT_PERSONAS.critic.authority.defaultPolicy, "critic-review");
  });

  it("denies workspace writes to every read-only persona", () => {
    for (const definition of listBuiltInAgentPersonas()) {
      const policy = definition.authority.defaultPolicy;
      if (policy === "read-only" || policy === "critic-review") {
        assert.equal(AGENT_AUTHORITY_RULES[policy].workspace, "read-only", definition.id);
      }
    }
  });
});

it("accepts a personal agent without handoff artifact fields", () => {
  const definition = decodeAgentPersonaDefinition({
    id: "my-reviewer",
    version: 1,
    displayName: "My Reviewer",
    description: "Reviews my changes.",
    instructions: "Review carefully.",
    authority: { defaultPolicy: "read-only", allowedPolicies: ["read-only"] },
    modelRoute: [
      { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
      { driver: "claudeAgent", model: "claude-opus-5", reasoningEffort: "high" },
    ],
  });
  assert.equal(definition.outputArtifact, undefined);
  assert.equal(definition.inputArtifacts, undefined);
  // Old definitions still declare handoff artifacts; the fields are ignored, never rejected.
  assert.equal(
    decodeAgentPersonaDefinition({ ...definition, outputArtifact: "Undeclared" }).outputArtifact,
    "Undeclared",
  );
});

it("loads ordered instance targets and access without legacy authority", () => {
  const { authority: _authority, ...legacy } = BUILT_IN_AGENT_PERSONAS.scout;
  const modelRoute = [
    { instanceId: "codex", model: "first", options: [{ id: "reasoningEffort", value: "high" }] },
    { instanceId: "claudeAgent", model: "second", options: [{ id: "effort", value: "high" }] },
    { instanceId: "codex", model: "third" },
  ];
  const definition = decodeAgentPersonaDefinition({ ...legacy, access: "read-only", modelRoute });
  assert.deepEqual<unknown>(definition.modelRoute, modelRoute);
  assert.equal(definition.access, "read-only");
  assert.isUndefined(definition.authority);
});

it("ignores obsolete artifact field types without dropping their stored values", () => {
  const definition = decodeAgentPersonaDefinition({
    ...BUILT_IN_AGENT_PERSONAS.scout,
    artifacts: { obsolete: true },
    inputArtifacts: 42,
    outputArtifact: false,
  });
  assert.deepEqual(definition.artifacts, { obsolete: true });
  assert.equal(definition.inputArtifacts, 42);
  assert.equal(definition.outputArtifact, false);
});

it("maps legacy defaults to three access levels without widening to allowed policies", () => {
  for (const [old, access] of [
    ["read-only", "read-only"],
    ["critic-review", "read-only"],
    ["workspace-write", "workspace-write"],
    ["critic-fix", "workspace-write"],
    ["full-access", "full-access"],
    ["diagnostic", undefined],
    ["publish-only", undefined],
  ] as const) {
    const definition = decodeAgentPersonaDefinition({
      ...BUILT_IN_AGENT_PERSONAS.scout,
      authority: { defaultPolicy: old, allowedPolicies: [old] },
    });
    assert.equal(agentPersonaAccess(definition), access);
  }
  assert.equal(agentPersonaAccess(BUILT_IN_AGENT_PERSONAS.critic), "read-only");
  assert.equal(
    agentPersonaAccess(
      decodeAgentPersonaDefinition({
        ...BUILT_IN_AGENT_PERSONAS.scout,
        authority: { defaultPolicy: "read-only", allowedPolicies: ["read-only", "diagnostic"] },
      }),
    ),
    "read-only",
  );
});

it("rejects ambiguous authority and access without changing the stored format", () => {
  assert.throws(() =>
    decodeAgentPersonaDefinition({ ...BUILT_IN_AGENT_PERSONAS.scout, access: "read-only" }),
  );
});

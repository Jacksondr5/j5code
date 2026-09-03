import { assert, describe, it } from "@effect/vitest";

import {
  AGENT_AUTHORITY_RULES,
  AGENT_PERSONA_IDS,
  BUILT_IN_AGENT_PERSONAS,
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
    assert.equal(BUILT_IN_AGENT_PERSONAS.publisher.outputArtifact, "PublicationReceipt");
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

  it("keeps Builder non-publishing and Publisher non-merging", () => {
    const builder = AGENT_AUTHORITY_RULES[BUILT_IN_AGENT_PERSONAS.builder.authority.defaultPolicy];
    assert.equal(builder.workspace, "write");
    assert.isFalse(builder.mayCommit);
    assert.isFalse(builder.mayPush);

    const publisher =
      AGENT_AUTHORITY_RULES[BUILT_IN_AGENT_PERSONAS.publisher.authority.defaultPolicy];
    assert.isTrue(publisher.mayCommit);
    assert.isTrue(publisher.mayPush);
    assert.isTrue(publisher.mayWritePullRequest);
    assert.isFalse(publisher.mayMergePullRequest);
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

  it("grants merge authority to no built-in persona mode", () => {
    for (const rules of Object.values(AGENT_AUTHORITY_RULES)) {
      assert.isFalse(rules.mayMergePullRequest);
    }
  });
});

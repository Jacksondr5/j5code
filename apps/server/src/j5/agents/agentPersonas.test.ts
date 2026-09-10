import { assert, it } from "@effect/vitest";
import { decodeAgentPersonaDefinition, getAgentAuthorityRules } from "./agentPersonas.ts";
import { TEST_PERSONAS } from "./testFixtures.ts";
it("validates generic definitions and their declared authority", () => {
  assert.throws(() =>
    decodeAgentPersonaDefinition({
      ...TEST_PERSONAS.scout,
      authority: { defaultPolicy: "workspace-write", allowedPolicies: ["read-only"] },
    }),
  );
  assert.throws(() =>
    decodeAgentPersonaDefinition({ ...TEST_PERSONAS.scout, outputArtifact: "Undeclared" }),
  );
  assert.equal(decodeAgentPersonaDefinition({ ...TEST_PERSONAS.scout, id: "custom" }).id, "custom");
  assert.isFalse(getAgentAuthorityRules("workspace-write").mayCommit);
  assert.isFalse(getAgentAuthorityRules("critic-review").mayMergePullRequest);
});

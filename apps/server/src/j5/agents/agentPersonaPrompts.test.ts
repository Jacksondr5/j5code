import { assert, describe, it } from "@effect/vitest";

import {
  BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1,
  getBuiltInAgentPersonaInstructions,
} from "./agentPersonaPrompts.ts";

describe("agent persona prompts", () => {
  it("defines Builder's inputs, review work, output, and publication boundary", () => {
    assert.include(BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1, "Plan Handoff");
    assert.include(BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1, "Diagnosis Handoff");
    assert.include(BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1, "Review Inbox");
    assert.include(BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1, "Critic and Sentry");
    assert.include(BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1, "Code Complete Handoff");
    assert.include(BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1, "Never commit or push");
  });

  it("resolves only the implemented Builder definition version", () => {
    assert.equal(
      getBuiltInAgentPersonaInstructions({ personaId: "builder", definitionVersion: 1 }),
      BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1,
    );
    assert.isUndefined(
      getBuiltInAgentPersonaInstructions({ personaId: "builder", definitionVersion: 2 }),
    );
    assert.isUndefined(
      getBuiltInAgentPersonaInstructions({ personaId: "critic", definitionVersion: 1 }),
    );
  });
});

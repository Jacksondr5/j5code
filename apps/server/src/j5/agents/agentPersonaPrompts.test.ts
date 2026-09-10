import { assert, it } from "@effect/vitest";
import { withAgentPersonaInstructions, agentPersonaPromptSuffix } from "./agentPersonaPrompts.ts";
it("composes only supplied persona instructions", () => {
  assert.equal(withAgentPersonaInstructions("base", "persona"), "base\n\npersona");
  assert.equal(withAgentPersonaInstructions("base", undefined), "base");
  assert.equal(agentPersonaPromptSuffix(undefined), "");
});

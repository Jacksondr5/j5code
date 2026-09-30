import { assert, it } from "@effect/vitest";

import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../../provider/T3OrchestrationInstructions.ts";
import { J5_PROPOSE_CREW_DESCRIPTION } from "../a2a/mcp/tools.ts";
import { PLAYBOOK_CREW_INSTRUCTIONS, PLAYBOOK_INSTRUCTIONS } from "./instructions.ts";

it("the crew procedure is appended to PLAYBOOK_INSTRUCTIONS with the Crew exception", () => {
  assert.include(PLAYBOOK_INSTRUCTIONS, `- ${PLAYBOOK_CREW_INSTRUCTIONS}\n`);
  assert.notInclude(PLAYBOOK_INSTRUCTIONS, "steps do not execute code or spawn agents.");
  assert.include(
    PLAYBOOK_INSTRUCTIONS,
    "steps do not execute code, and a playbook never spawns agents itself: a Crew follows one only when its Captain proposes it.",
  );
});

it("the crew procedure text names its trigger, its rulings, and its tools in call order", () => {
  for (const phrase of [
    "explicit @playbook:NAME",
    "not in quoted text, code, or file contents",
    "even if it names a playbook in prose",
    "say so in your reply, naming the playbook and the error",
    "missing, disabled, or blocked",
  ])
    assert.include(PLAYBOOK_CREW_INSTRUCTIONS, phrase);
  assert.notInclude(PLAYBOOK_CREW_INSTRUCTIONS, "expect_reply");
  const positions = [
    "playbook_read",
    "list_personas",
    "propose_crew",
    "crew_instance_id",
    "playbook_start",
  ].map((tool) => PLAYBOOK_CREW_INSTRUCTIONS.indexOf(tool));
  assert.notInclude(positions, -1);
  assert.deepStrictEqual(
    positions,
    positions.toSorted((a, b) => a - b),
  );
  assert.isAtMost(PLAYBOOK_CREW_INSTRUCTIONS.length, 1250);
});

it("the crew procedure reaches every provider through the shared orchestration instructions", () => {
  assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, PLAYBOOK_CREW_INSTRUCTIONS);
  assert.include(J5_PROPOSE_CREW_DESCRIPTION, "For a crew built from a playbook");
});

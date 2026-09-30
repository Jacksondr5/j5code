import { assert, it } from "@effect/vitest";

import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../../provider/T3OrchestrationInstructions.ts";
import { J5_PROPOSE_CREW_DESCRIPTION } from "../a2a/mcp/tools.ts";
import { PLAYBOOK_CREW_INSTRUCTIONS, PLAYBOOK_INSTRUCTIONS } from "./instructions.ts";

it("carries the Crew procedure and says a playbook spawns agents only through its Captain", () => {
  assert.include(PLAYBOOK_INSTRUCTIONS, `- ${PLAYBOOK_CREW_INSTRUCTIONS}\n`);
  assert.notInclude(PLAYBOOK_INSTRUCTIONS, "steps do not execute code or spawn agents.");
  assert.include(
    PLAYBOOK_INSTRUCTIONS,
    "steps do not execute code, and a playbook never spawns agents itself: a Crew follows one only when its Captain proposes it.",
  );
});

it("runs only on an explicit mention outside quotes and code", () => {
  assert.include(PLAYBOOK_CREW_INSTRUCTIONS, "explicit @playbook:NAME");
  assert.include(PLAYBOOK_CREW_INSTRUCTIONS, "not in quoted text, code, or file contents");
  assert.include(PLAYBOOK_CREW_INSTRUCTIONS, "even if it names a playbook in prose");
});

it("names the tools in the order the Captain calls them, and the inbox ask on a failed read", () => {
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
  assert.include(PLAYBOOK_CREW_INSTRUCTIONS, "send_message (expect_reply)");
  // Short enough that neither provider skims past a step.
  assert.isAtMost(PLAYBOOK_CREW_INSTRUCTIONS.length, 1250);
});

it("reaches every provider through the shared orchestration instructions", () => {
  assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, PLAYBOOK_CREW_INSTRUCTIONS);
  assert.include(J5_PROPOSE_CREW_DESCRIPTION, "For a crew built from a playbook");
});

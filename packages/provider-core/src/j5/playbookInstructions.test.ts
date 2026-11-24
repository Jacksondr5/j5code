import { assert, it } from "@effect/vitest";

import { J5_ORCHESTRATION_INSTRUCTIONS } from "./orchestrationInstructions.ts";
import { PLAYBOOK_INSTRUCTIONS } from "./playbookInstructions.ts";

it("gives the owner a way to choose, staff, change, and finish a run", () => {
  for (const guidance of [
    "clearly fits the request, even when they did not name one",
    "Say which playbook you are using",
    "If the fit is unclear or several fit, ask which to use before starting",
    "only if the configured task prompt names it",
    "Spawn that persona normally",
    "preserves the assignment's scope and approvals",
    "Work directly on sequential work, use delegate_task",
    "propose a Crew with j5_propose_crew",
    "change arrangements mid-run and carry forward work already finished",
    "Only the owner advances",
    "A pending personaApproval gates launches that need the limits lifted",
    "still use an eligible matching holder or launch the persona on a route within your limits",
    "wait for the server Owner's decision",
    "Revise the run copy with j5_playbook_revise only after the person asks or approves",
    "record why you skipped it",
    "Stop other workers you assigned for the run with t3_thread_interrupt",
    "task_cancel for delegated subagents",
    "only after every required outcome and checkpoint is satisfied",
    "Give the person the result, relevant verification, and remaining limitations",
    "Report unresolved required work as a blocker",
  ]) {
    assert.include(PLAYBOOK_INSTRUCTIONS, guidance);
  }
});

it("replaces Crew-specific starting and movement guidance in provider instructions", () => {
  assert.include(J5_ORCHESTRATION_INSTRUCTIONS, PLAYBOOK_INSTRUCTIONS.trim());
  for (const obsolete of [
    "A playbook merely named in passing",
    "Playbooks in a Crew:",
    "the new member takes over the seat's unfinished playbook steps",
    "j5_stop_agent",
  ]) {
    assert.notInclude(J5_ORCHESTRATION_INSTRUCTIONS, obsolete);
  }
});

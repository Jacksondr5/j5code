import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";

import type { CrewProposalSeat } from "./AgentCrewProposalService.ts";
import type { CrewCaptain, ResolvedCrewLaunchSeat } from "./CrewLaunchService.ts";
import { planCrewPlaybook, withPersonaSwaps } from "./crewPlaybookPlan.ts";
import { crewApprovalToken } from "./crewRuntimePreview.ts";

const definition = {
  name: "release",
  title: "Release",
  steps: [
    { id: "plan", title: "Plan", prompt: "Plan it.", persona: "planner" },
    { id: "build", title: "Build", prompt: "Build it.", persona: "builder-bot" },
    { id: "review", title: "Review", prompt: "Review it." },
  ],
};
const catalog = { definitions: [{ id: "builder-bot" }], disabledIds: ["builder-bot"] };
const seat = (name: string, agentId: string | null, steps?: ReadonlyArray<string>) =>
  ({
    seat: name,
    agentId,
    reason: "Holds a seat",
    ...(steps === undefined ? {} : { steps }),
  }) satisfies CrewProposalSeat;

describe("planCrewPlaybook", () => {
  it("records swaps and unowned steps for a valid plan", () => {
    const plan = planCrewPlaybook({
      definition,
      seats: [seat("lead", "planner", ["plan"]), seat("maker", null, ["build"])],
      existingMembers: [],
      catalog,
    });
    assert.isNull(plan.problem);
    if (plan.problem !== null) return;
    assert.deepStrictEqual(plan.unownedSteps, ["review"]);
    assert.deepStrictEqual(
      [...plan.swapsBySeat],
      [
        [
          "maker",
          [
            {
              stepId: "build",
              wanted: "builder-bot",
              seatPersona: null,
              wantedProblem: "disabled",
            },
          ],
        ],
      ],
    );
    assert.deepStrictEqual(plan.summary?.steps[2], { id: "review", title: "Review" });
  });

  it("counts a live member's steps as owned for an addition", () => {
    const plan = planCrewPlaybook({
      definition,
      seats: [seat("reviewer", null, ["review"])],
      existingMembers: [{ seatName: "lead", playbookStepIds: ["plan"] }],
      catalog,
    });
    assert.isNull(plan.problem);
    if (plan.problem === null) assert.deepStrictEqual(plan.unownedSteps, ["build"]);
  });

  it.each([
    {
      name: "a step the playbook lacks",
      seats: [seat("lead", null, ["ship"])],
      existingMembers: [],
      detail: "Seat lead lists step ship, which playbook release does not have.",
    },
    {
      name: "a step claimed by two seats",
      seats: [seat("lead", null, ["plan"]), seat("maker", null, ["plan"])],
      existingMembers: [],
      detail: "Step plan is claimed by seat lead and seat maker; a step has one owner.",
    },
    {
      name: "a step a live member owns",
      seats: [seat("maker", null, ["plan"])],
      existingMembers: [{ seatName: "lead", playbookStepIds: ["plan"] }],
      detail: "Step plan is already owned by seat lead.",
    },
  ])("refuses $name", ({ seats, existingMembers, detail }) => {
    const plan = planCrewPlaybook({ definition, seats, existingMembers, catalog });
    assert.equal(plan.problem?.detail, detail);
    assert.isNotEmpty(plan.problem?.nextStep);
  });

  it("refuses steps on a crew without a playbook and passes one without steps", () => {
    const refused = planCrewPlaybook({
      definition: null,
      seats: [seat("lead", null, ["plan"])],
      existingMembers: [],
      catalog,
    });
    assert.equal(
      refused.problem?.detail,
      "Seat lead lists steps, but the crew follows no playbook.",
    );
    const plain = planCrewPlaybook({
      definition: null,
      seats: [seat("lead", null)],
      existingMembers: [],
      catalog,
    });
    assert.deepStrictEqual(plain, {
      problem: null,
      summary: null,
      unownedSteps: [],
      swapsBySeat: new Map(),
    });
  });

  it("replaces client-sent swaps with the server's", () => {
    const forged = {
      ...seat("lead", null, ["review"]),
      personaSwaps: [{ stepId: "review", wanted: "x", seatPersona: null, wantedProblem: null }],
    };
    assert.deepStrictEqual(withPersonaSwaps([forged], new Map()), [seat("lead", null, ["review"])]);
  });
});

describe("crewApprovalToken", () => {
  it("is byte-identical to the pre-playbook token when the Crew follows none", () => {
    const proposal = { id: "proposal:1", brief: "Ship it.", displayName: "Crew" } as never;
    const captain = {
      thread: {
        projectId: "project:1",
        branch: "main",
        worktreePath: "/repo",
        interactionMode: "default",
      },
    } as unknown as CrewCaptain;
    const seats = [
      { seat: { name: "helper", agentId: null, reason: "Helps" } },
    ] as unknown as ReadonlyArray<ResolvedCrewLaunchSeat>;
    const before = NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify({
          proposalId: "proposal:1",
          brief: "Ship it.",
          displayName: "Crew",
          projectId: "project:1",
          branch: "main",
          worktreePath: "/repo",
          interactionMode: "default",
          seats,
        }),
      )
      .digest("hex");
    assert.equal(crewApprovalToken(proposal, captain, seats), before);
    assert.notEqual(crewApprovalToken(proposal, captain, seats, "plan-digest"), before);
  });
});

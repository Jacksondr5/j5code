import { describe, expect, it } from "vite-plus/test";

import { describePersonaSwap, removedSeatSteps, stepTitle, unownedSteps } from "./crewPlaybookPlan";
import { removeSeat } from "./crewProposalDraft";

const playbook = {
  name: "release",
  title: "Release",
  steps: [
    { id: "plan", title: "Plan", persona: "planner" },
    { id: "build", title: "Build" },
    { id: "review", title: "Review" },
  ],
  issue: null,
};
const seats = [
  { seat: "lead", agentId: null, reason: "Plans", steps: ["plan"] },
  { seat: "maker", agentId: "builder-bot", reason: "Builds", steps: ["build"] },
];

describe("crew playbook plan on the card", () => {
  it("leaves a removed seat's steps unowned and says which", () => {
    expect(unownedSteps(playbook, seats)).toEqual(["review"]);
    const remaining = removeSeat(seats, "lead");
    expect(unownedSteps(playbook, remaining)).toEqual(["plan", "review"]);
    expect(removedSeatSteps(seats, remaining)).toEqual([{ seat: "lead", steps: ["plan"] }]);
    expect(unownedSteps(null, seats)).toEqual([]);
  });

  it("names steps by live title and falls back to the id", () => {
    expect(stepTitle(playbook, "build")).toBe("Build");
    expect(stepTitle(playbook, "ship")).toBe("ship");
  });

  it("describes a swap, including why the wanted persona could not staff it", () => {
    expect(
      describePersonaSwap(
        { stepId: "plan", wanted: "planner", seatPersona: null, wantedProblem: "disabled" },
        "lead",
      ),
    ).toBe("wants planner; lead is a custom seat (planner is turned off)");
    expect(
      describePersonaSwap(
        { stepId: "plan", wanted: "planner", seatPersona: "builder-bot", wantedProblem: null },
        "maker",
      ),
    ).toBe("wants planner; maker is builder-bot");
  });
});

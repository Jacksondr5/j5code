import type { CrewProposal, CrewProposalSeat } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import {
  crewPreviewIsComplete,
  crewPreviewRuntimeForSeats,
  crewSeatStopsForApprovals,
  describeCrewSeatWorkspace,
  describePersonaSwap,
  removedSeatSteps,
  removeSeat,
  rosterGatesForThread,
  stepTitle,
  unownedSteps,
} from "./crewProposals.ts";

const proposal = (overrides: Partial<CrewProposal>): CrewProposal => ({
  id: "proposal:1",
  projectId: "project:1",
  captainParticipantId: "agent:j5:a2a:thread:captain",
  captainThreadId: "thread:captain",
  crewInstanceId: null,
  kind: "roster",
  status: "open",
  displayName: "Review",
  brief: "Review the branch",
  requestedSeats: [{ seat: "critic", agentId: "critic", reason: "Reviews" }],
  approvedSeats: null,
  createdAt: "2026-09-10T00:00:00.000Z",
  resolvedAt: null,
  ...overrides,
});

describe("crew gate routing", () => {
  const proposals = [
    proposal({ id: "roster-here" }),
    proposal({ id: "roster-elsewhere", captainThreadId: "thread:other" }),
    proposal({ id: "addition", kind: "addition", crewInstanceId: "crew:1" }),
    proposal({ id: "resolved", status: "approved", resolvedAt: "2026-09-10T00:01:00.000Z" }),
  ];

  it("shows this thread's open roster and legacy addition gates inline", () => {
    expect(rosterGatesForThread(proposals, "thread:captain").map((p) => p.id)).toEqual([
      "roster-here",
      "addition",
    ]);
    expect(rosterGatesForThread(proposals, null)).toEqual([]);
    expect(rosterGatesForThread(proposals, "thread:none")).toEqual([]);
  });

  it("does not show automatic approvals as human gates", () => {
    expect(
      rosterGatesForThread([proposal({ approvalMode: "automatic" })], "thread:captain"),
    ).toEqual([]);
  });
});

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
const planSeats = [
  { seat: "lead", agentId: null, reason: "Plans", steps: ["plan"] },
  { seat: "maker", agentId: "builder-bot", reason: "Builds", steps: ["build"] },
];

describe("crew playbook plan on the card", () => {
  it("leaves a removed seat's steps unowned and says which", () => {
    expect(unownedSteps(playbook, planSeats)).toEqual(["review"]);
    const remaining = removeSeat(planSeats, "lead");
    expect(unownedSteps(playbook, remaining)).toEqual(["plan", "review"]);
    expect(removedSeatSteps(planSeats, remaining)).toEqual([{ seat: "lead", steps: ["plan"] }]);
    expect(unownedSteps(null, planSeats)).toEqual([]);
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

describe("crewSeatStopsForApprovals", () => {
  const custom = { agentId: null } as const;
  const persona = { agentId: "critic" } as const;
  it("flags custom seats and overridden personas whose access is short of Full access", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      expect(crewSeatStopsForApprovals(custom, { runtimeMode })).toBe(true);
      expect(crewSeatStopsForApprovals({ ...persona, runtimeMode }, { runtimeMode })).toBe(true);
    }
    expect(crewSeatStopsForApprovals(custom, { runtimeMode: "full-access" })).toBe(false);
    expect(
      crewSeatStopsForApprovals(
        { ...persona, runtimeMode: "full-access" },
        { runtimeMode: "full-access" },
      ),
    ).toBe(false);
  });

  it("leaves persona defaults and unresolved runtimes quiet", () => {
    // A read-only persona resolves to approval-required with approvals disabled: it never asks.
    expect(crewSeatStopsForApprovals(persona, { runtimeMode: "approval-required" })).toBe(false);
    expect(crewSeatStopsForApprovals(custom, undefined)).toBe(false);
  });
});

describe("crew seat workspace line", () => {
  it("describes each choice on the seat row", () => {
    expect(
      describeCrewSeatWorkspace({
        type: "worktree",
        baseRef: "main",
        baseCommit: "3f9c2ab1".repeat(5),
      }),
    ).toBe("New worktree from main @ 3f9c2ab1");
    expect(describeCrewSeatWorkspace({ type: "shared" })).toBe("Captain's checkout");
    expect(describeCrewSeatWorkspace({ type: "worktree", baseRef: "release" })).toBe(
      "New worktree from release",
    );
    expect(
      describeCrewSeatWorkspace({
        type: "existing_worktree",
        worktreePath: "/repo-worktrees/builder",
        branch: "fix/login",
      }),
    ).toBe("Existing worktree on fix/login");
  });
});

describe("crew preview binding", () => {
  const critic: CrewProposalSeat = { seat: "critic", agentId: "critic", reason: "Reviews" };
  const builder: CrewProposalSeat = { seat: "builder", agentId: null, reason: "Builds" };
  const runtime = (seat: string) =>
    ({ seat, model: "Haiku 5.5", reasoning: "low", access: "Full access" }) as never;
  const preview = (seats: ReadonlyArray<string>, approvalToken = "token") => ({
    proposalId: "proposal:1",
    approvalToken,
    seats: seats.map(runtime),
  });

  it("counts only a preview of exactly the seats on screen", () => {
    expect(
      crewPreviewIsComplete(preview(["critic", "builder"]), "proposal:1", [critic, builder]),
    ).toBe(true);
    // After the person removes builder, the earlier two-seat preview must not approve one seat.
    expect(crewPreviewIsComplete(preview(["critic", "builder"]), "proposal:1", [critic])).toBe(
      false,
    );
    expect(crewPreviewIsComplete(preview(["critic"]), "proposal:1", [critic, builder])).toBe(false);
    expect(
      crewPreviewIsComplete(preview(["critic", "critic"]), "proposal:1", [critic, builder]),
    ).toBe(false);
    expect(crewPreviewIsComplete(preview(["critic"], ""), "proposal:1", [critic])).toBe(false);
    expect(crewPreviewIsComplete(preview(["critic"]), "proposal:2", [critic])).toBe(false);
  });

  it("keeps an old runtime row only for a seat whose settings are unchanged", () => {
    const rows = [runtime("critic"), runtime("builder")];
    const changed = { ...builder, runtimeMode: "approval-required" as const };
    expect(
      crewPreviewRuntimeForSeats(rows, [critic, builder], [critic, changed]).map((row) => row.seat),
    ).toEqual(["critic"]);
    expect(
      crewPreviewRuntimeForSeats(rows, [critic, builder], [critic]).map((row) => row.seat),
    ).toEqual(["critic"]);
  });
});

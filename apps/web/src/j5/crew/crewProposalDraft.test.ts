import { describe, expect, it } from "vite-plus/test";

import { CUSTOM_AGENT, addSeat, describeSeatAgent, removeSeat } from "./crewProposalDraft";

describe("crew proposal roster edits", () => {
  const seats = [
    { seat: "builder", agentId: "builder", reason: "Implements" },
    { seat: "critic", agentId: "critic", reason: "Reviews" },
  ];

  it("removes a seat by name and adds a normalized seat with the user's instructions", () => {
    expect(removeSeat(seats, "critic").map((seat) => seat.seat)).toEqual(["builder"]);
    const added = addSeat(seats, { seat: "Security Pass", agentId: "sentry", instructions: "  " });
    expect(added.error).toBeNull();
    expect(added.seats.at(-1)).toEqual({
      seat: "security-pass",
      agentId: "sentry",
      reason: "Added by the user",
    });
    const briefed = addSeat(seats, {
      seat: "eyes",
      agentId: "sentry",
      instructions: " Review only the auth module. ",
    });
    expect(briefed.seats.at(-1)?.instructions).toBe("Review only the auth module.");
  });

  it("names saved and custom seats without inferring runtime or access", () => {
    const rows = [
      { personaId: "critic", displayName: "Critic", authority: "Review only" },
      { personaId: "builder", displayName: "Builder", authority: "Workspace write" },
    ];
    expect(describeSeatAgent(rows, "builder")).toBe("Builder");
    expect(describeSeatAgent(rows, "ghost")).toBe("ghost");
    expect(describeSeatAgent(rows, null)).toBe("Custom seat");
  });

  it("adds a custom seat with no persona behind it once it has instructions", () => {
    expect(
      addSeat(seats, { seat: "scribe", agentId: CUSTOM_AGENT, instructions: " " }).error,
    ).toContain("Give the custom seat");
    const custom = addSeat(seats, {
      seat: "scribe",
      agentId: CUSTOM_AGENT,
      instructions: "Keep the running notes.",
    });
    expect(custom.error).toBeNull();
    expect(custom.seats.at(-1)).toEqual({
      seat: "scribe",
      agentId: null,
      reason: "Added by the user",
      instructions: "Keep the running notes.",
    });
  });

  it("rejects duplicate or malformed seat names and a missing persona", () => {
    expect(addSeat(seats, { seat: "builder", agentId: "scout", instructions: "" }).error).toContain(
      "already exists",
    );
    expect(addSeat(seats, { seat: "9lives", agentId: "scout", instructions: "" }).error).toContain(
      "lowercase",
    );
    expect(addSeat(seats, { seat: "eyes", agentId: "", instructions: "" }).error).toContain(
      "Pick a persona",
    );
  });
});

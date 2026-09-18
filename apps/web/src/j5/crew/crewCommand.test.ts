import { describe, expect, it } from "vite-plus/test";

import { CUSTOM_AGENT, addSeat, describeSeatAgent, removeSeat } from "./CrewProposalCard";
import { crewCommandRefusal, crewLaunchPrompt, parseCrewCommand } from "./crewCommand";
import { j5CrewSlashCommandItems } from "./crewSlashCommand";
import { ProviderDriverKind } from "@t3tools/contracts";

describe("/crew command", () => {
  it("recognizes the command with a brief and ignores ordinary text", () => {
    expect(parseCrewCommand("/crew fix the flaky login test")).toEqual({
      kind: "launch",
      brief: "fix the flaky login test",
    });
    expect(parseCrewCommand("  /crew\n  Follow @docs/runbook.md\n  and report back ")).toEqual({
      kind: "launch",
      brief: "Follow @docs/runbook.md\n  and report back",
    });
    expect(parseCrewCommand("/crew")).toEqual({ kind: "missing-brief" });
    expect(parseCrewCommand("/crews go")).toBeNull();
    expect(parseCrewCommand("please /crew this")).toBeNull();
  });

  it("refuses only a missing brief; any thread and any agent may compose a crew", () => {
    expect(crewCommandRefusal({ kind: "missing-brief" })?.title).toBe("Give the crew a brief");
    expect(crewCommandRefusal({ kind: "launch", brief: "x" })).toBeNull();
  });

  it("sends the brief verbatim after the platform's crew guidance", () => {
    const prompt = crewLaunchPrompt("Land the invoice-export PR: build, review, sit on CI.");
    expect(prompt.startsWith("<j5_crew_launch>\n")).toBe(true);
    expect(
      prompt.endsWith("</j5_crew_launch>\n\nLand the invoice-export PR: build, review, sit on CI."),
    ).toBe(true);
    expect(prompt).toContain("propose_crew");
    expect(prompt).toContain("end your turn");
  });
});

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

  it("names the agent and the access a seat is approved with, or admits it cannot", () => {
    const rows = [
      { personaId: "critic", displayName: "Critic", authority: "Review only" },
      { personaId: "builder", displayName: "Builder", authority: "Workspace write" },
    ];
    expect(describeSeatAgent(rows, "builder")).toEqual({
      name: "Builder",
      authority: "Workspace write",
    });
    expect(describeSeatAgent(rows, "ghost")).toEqual({ name: "ghost", authority: null });
    expect(describeSeatAgent(rows, null)).toEqual({
      name: "Custom agent",
      authority: "Runs with the Captain's model and access mode",
    });
  });

  it("adds a custom seat with no agent behind it once it has instructions", () => {
    expect(
      addSeat(seats, { seat: "scribe", agentId: CUSTOM_AGENT, instructions: " " }).error,
    ).toContain("Give the custom agent");
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

  it("rejects duplicate or malformed seat names and a missing agent", () => {
    expect(addSeat(seats, { seat: "builder", agentId: "scout", instructions: "" }).error).toContain(
      "already exists",
    );
    expect(addSeat(seats, { seat: "9lives", agentId: "scout", instructions: "" }).error).toContain(
      "lowercase",
    );
    expect(addSeat(seats, { seat: "eyes", agentId: "", instructions: "" }).error).toContain(
      "Pick an agent",
    );
  });
});

describe("/crew slash menu entry", () => {
  it("offers /crew in every composer and inserts the command on selection", () => {
    const codex = ProviderDriverKind.make("codex");
    const [item] = j5CrewSlashCommandItems(codex);
    expect(item).toMatchObject({
      type: "provider-slash-command",
      label: "/crew",
      command: { name: "crew" },
    });
  });
});

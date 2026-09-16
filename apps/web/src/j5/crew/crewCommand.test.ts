import { describe, expect, it } from "vite-plus/test";

import { addSeat, describeSeatAgent, removeSeat } from "./CrewProposalCard";
import { CREW_CAPTAIN_PERSONA, crewCommandRefusal, parseCrewCommand } from "./crewCommand";
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
    expect(CREW_CAPTAIN_PERSONA.personaId).toBe("crew-captain");
  });

  it("refuses without a brief or on an existing thread, and allows a fresh draft", () => {
    const draft = { isLocalDraftThread: true, captainAvailable: true };
    expect(crewCommandRefusal({ kind: "missing-brief" }, draft)?.title).toBe(
      "Give the crew a brief",
    );
    expect(
      crewCommandRefusal({ kind: "launch", brief: "x" }, { ...draft, isLocalDraftThread: false })
        ?.title,
    ).toBe("Start a new thread for a crew");
    expect(
      crewCommandRefusal({ kind: "launch", brief: "x" }, { ...draft, captainAvailable: false })
        ?.title,
    ).toBe("Add a crew-captain agent first");
    // Unknown availability defers to the server rather than blocking the send.
    expect(
      crewCommandRefusal({ kind: "launch", brief: "x" }, { ...draft, captainAvailable: null }),
    ).toBeNull();
    expect(crewCommandRefusal({ kind: "launch", brief: "x" }, draft)).toBeNull();
  });
});

describe("crew proposal roster edits", () => {
  const seats = [
    { seat: "builder", agentId: "builder", reason: "Implements" },
    { seat: "critic", agentId: "critic", reason: "Reviews" },
  ];

  it("removes a seat by name and adds a normalized seat with a default reason", () => {
    expect(removeSeat(seats, "critic").map((seat) => seat.seat)).toEqual(["builder"]);
    const added = addSeat(seats, { seat: "Security Pass", agentId: "sentry", reason: "  " });
    expect(added.error).toBeNull();
    expect(added.seats.at(-1)).toEqual({
      seat: "security-pass",
      agentId: "sentry",
      reason: "Added by the user",
    });
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
  });

  it("rejects duplicate or malformed seat names and a missing agent", () => {
    expect(addSeat(seats, { seat: "builder", agentId: "scout", reason: "r" }).error).toContain(
      "already exists",
    );
    expect(addSeat(seats, { seat: "9lives", agentId: "scout", reason: "r" }).error).toContain(
      "lowercase",
    );
    expect(addSeat(seats, { seat: "eyes", agentId: "", reason: "r" }).error).toContain(
      "Pick an agent",
    );
  });
});

describe("/crew slash menu entry", () => {
  it("offers /crew only on a fresh draft and inserts the command on selection", () => {
    const codex = ProviderDriverKind.make("codex");
    expect(j5CrewSlashCommandItems(codex, true)).toEqual([]);
    const [item] = j5CrewSlashCommandItems(codex, false);
    expect(item).toMatchObject({
      type: "provider-slash-command",
      label: "/crew",
      command: { name: "crew" },
    });
  });
});

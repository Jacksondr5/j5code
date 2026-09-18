import { describe, expect, it } from "vite-plus/test";

import { crewLaunchPrompt } from "./crewCommand";
import {
  crewGateFooter,
  crewGateTitle,
  participantIdsForCrewNotice,
  presentCrewNotice,
} from "./crewNotices.logic";

const approvedGate = [
  "<j5_crew_gate>",
  "proposal_id: crew:j5:a2a:mcp:s:proposal:r1",
  "kind: roster",
  "decision: approved",
  "crew_name: Invoice Export PR",
  "crew_instance_id: crew:1",
  "crew_version: 1",
  "roster:",
  "- builder: participant_id=agent:j5:a2a:b agent=builder thread_id=thread:b",
  "- critic: participant_id=agent:j5:a2a:c agent=critic thread_id=thread:c",
  "</j5_crew_gate>",
  "",
  "Your crew is running. Each seat has your brief and this roster.",
].join("\n");

describe("crew notices in the Captain's thread", () => {
  it("presents the person's /crew turn as its brief with the guidance set aside", () => {
    const notice = presentCrewNotice({
      role: "user",
      createdBy: "user",
      text: crewLaunchPrompt("Land the invoice-export PR: build, review, sit on CI."),
    });
    expect(notice).toMatchObject({
      kind: "launch",
      brief: "Land the invoice-export PR: build, review, sit on CI.",
    });
    expect(notice?.kind === "launch" && notice.guidance).toContain("propose_crew");
    // A message that merely mentions the tag, or an empty brief, stays an ordinary message.
    expect(presentCrewNotice({ role: "user", text: "about <j5_crew_launch> tags" })).toBeNull();
    expect(
      presentCrewNotice({ role: "user", text: "<j5_crew_launch>\nx\n</j5_crew_launch>\n\n" }),
    ).toBeNull();
    expect(presentCrewNotice({ role: "assistant", text: crewLaunchPrompt("x") })).toBeNull();
    // Claude's effort prefix lands ahead of the wrapper; the card still recognizes the turn, and
    // contexts appended after the brief stay part of what the Captain received.
    const prefixed = presentCrewNotice({
      role: "user",
      createdBy: "user",
      text: `Ultrathink:\n${crewLaunchPrompt("Fix it.")}\n\n<terminal_context>\n$ ls\n</terminal_context>`,
    });
    expect(prefixed).toMatchObject({ kind: "launch" });
    expect(prefixed?.kind === "launch" && prefixed.brief).toContain("Fix it.");
    expect(prefixed?.kind === "launch" && prefixed.brief).toContain("terminal_context");
  });

  it("presents an approved roster with its seats and names the seats for the identity read", () => {
    const message = { role: "user", createdBy: "system", text: approvedGate };
    const notice = presentCrewNotice(message);
    expect(notice).toEqual({
      kind: "gate",
      proposalId: "crew:j5:a2a:mcp:s:proposal:r1",
      requestKind: "roster",
      decision: "approved",
      crewName: "Invoice Export PR",
      crewInstanceId: "crew:1",
      crewVersion: 1,
      roster: [
        {
          seat: "builder",
          participantId: "agent:j5:a2a:b",
          agentId: "builder",
          threadId: "thread:b",
          isNew: false,
          start: null,
        },
        {
          seat: "critic",
          participantId: "agent:j5:a2a:c",
          agentId: "critic",
          threadId: "thread:c",
          isNew: false,
          start: null,
        },
      ],
      requestedSeats: [],
      changes: null,
      failures: [],
      pendingSeats: [],
    });
    expect(participantIdsForCrewNotice(message)).toEqual(["agent:j5:a2a:b", "agent:j5:a2a:c"]);
    if (notice?.kind === "gate") expect(crewGateTitle(notice)).toBe("Crew launched");
    // Only the platform posts gate notices; the same text from a person is not one.
    expect(presentCrewNotice({ role: "user", createdBy: "user", text: approvedGate })).toBeNull();
  });

  it("presents a launch report: what the person changed and how each seat's first turn went", () => {
    const report = [
      "<j5_crew_gate>",
      "proposal_id: crew:j5:a2a:mcp:s:proposal:r2",
      "kind: roster",
      "decision: approved",
      "crew_name: Comedy",
      "crew_instance_id: crew:2",
      "crew_version: 1",
      "changes: added prosecutor; removed sitter",
      "launch: 1 started, 1 failed to start, 1 not started after 60s",
      "seat_failed: punchline | failed | provider_error — API Error: Can't reach the API server | check DNS",
      "seat_pending: prosecutor",
      "roster:",
      "- setup: participant_id=agent:j5:a2a:s agent=scout thread_id=thread:s start=started",
      "- punchline: participant_id=agent:j5:a2a:p agent=advocate thread_id=thread:p start=failed",
      "- prosecutor: participant_id=agent:j5:a2a:q agent=prosecutor thread_id=thread:q start=pending",
      "</j5_crew_gate>",
      "",
      "1 of 3 seats failed to start.",
    ].join("\n");
    const notice = presentCrewNotice({ role: "user", createdBy: "system", text: report });
    expect(notice).toMatchObject({
      kind: "gate",
      changes: "added prosecutor; removed sitter",
      failures: [
        {
          seat: "punchline",
          runStatus: "failed",
          detail: "provider_error — API Error: Can't reach the API server | check DNS",
        },
      ],
      pendingSeats: ["prosecutor"],
    });
    expect(notice?.kind === "gate" && notice.roster.map((seat) => seat.start)).toEqual([
      "started",
      "failed",
      "pending",
    ]);
    if (notice?.kind === "gate") {
      expect(crewGateTitle(notice)).toBe("Crew launched, 1 seat failed to start");
      expect(crewGateFooter(notice)).toBe(
        "1 seat failed to start; the Captain has each reason. 1 seat has no confirmed provider activity after a minute.",
      );
    }
  });

  it("presents an added seat as new and a decline with what was requested", () => {
    const addition = approvedGate
      .replace("kind: roster", "kind: addition")
      .replace("crew_version: 1", "crew_version: 2")
      .replace("thread_id=thread:c", "thread_id=thread:c (new)");
    const added = presentCrewNotice({ role: "user", createdBy: "system", text: addition });
    expect(added?.kind === "gate" && added.roster.map((seat) => seat.isNew)).toEqual([false, true]);
    if (added?.kind === "gate") expect(crewGateTitle(added)).toBe("Seat added");

    const declined = presentCrewNotice({
      role: "user",
      createdBy: "system",
      text: "<j5_crew_gate>\nproposal_id: p2\nkind: addition\ndecision: declined\ncrew_name: Invoice Export PR\nrequested_seats: sitter=sentry\n</j5_crew_gate>\n\nThe human declined this crew request.",
    });
    expect(declined).toMatchObject({
      kind: "gate",
      decision: "declined",
      crewInstanceId: null,
      crewVersion: null,
      roster: [],
      requestedSeats: [{ seat: "sitter", agentId: "sentry" }],
    });
    if (declined?.kind === "gate") expect(crewGateTitle(declined)).toBe("Seat declined");
    // An unreadable block stays raw rather than becoming a card that guesses.
    expect(
      presentCrewNotice({
        role: "user",
        createdBy: "system",
        text: "<j5_crew_gate>\nkind: roster\n</j5_crew_gate>",
      }),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import { inboxCrewRequests, rosterGatesForThread } from "./crewProposals.logic";
import type { CrewProposal } from "./crewProposalsClient";

const proposal = (overrides: Partial<CrewProposal>): CrewProposal => ({
  id: "proposal:1",
  squadronId: "squadron:1",
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

  it("shows only this thread's open roster gate inline", () => {
    expect(rosterGatesForThread(proposals, "thread:captain").map((p) => p.id)).toEqual([
      "roster-here",
    ]);
    expect(rosterGatesForThread(proposals, null)).toEqual([]);
    expect(rosterGatesForThread(proposals, "thread:none")).toEqual([]);
  });

  it("sends only open additions to the inbox bell", () => {
    expect(inboxCrewRequests(proposals).map((p) => p.id)).toEqual(["addition"]);
  });
});

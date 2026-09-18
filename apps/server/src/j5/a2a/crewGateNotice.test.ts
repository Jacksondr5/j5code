import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import type { AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import type { CrewProposal } from "./AgentCrewProposalService.ts";
import { crewLaunchReportText, crewRosterChanges } from "./crewGateNotice.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const seat = (name: string, agentId: string, reason = `${name} does its part`) => ({
  seat: name,
  agentId,
  reason,
});

describe("crew roster changes", () => {
  it("names what the person added, removed, and renamed against the proposal", () => {
    const changes = crewRosterChanges(
      [seat("builder", "builder"), seat("critic", "critic", "Reviews"), seat("sitter", "sentry")],
      [
        seat("builder", "builder"),
        seat("reviewer", "critic", "Reviews"),
        seat("sentry", "sentry", "Security"),
      ],
    );
    assert.deepStrictEqual(changes, {
      added: ["sentry"],
      removed: ["sitter"],
      renamed: [{ from: "critic", to: "reviewer" }],
    });
    assert.deepStrictEqual(crewRosterChanges([seat("a", "x")], [seat("a", "x")]), {
      added: [],
      removed: [],
      renamed: [],
    });
  });
});

describe("crew launch report", () => {
  const proposal: CrewProposal = {
    id: "proposal:1",
    squadronId: SquadronId.make("squadron:1"),
    captainParticipantId: ParticipantId.make("agent:captain"),
    captainThreadId: ThreadId.make("thread:captain"),
    crewInstanceId: "crew:1",
    kind: "roster",
    status: "approved",
    brief: "Tell two jokes.",
    displayName: "Comedy",
    requestedSeats: [seat("setup", "scout"), seat("punchline", "advocate")],
    approvedSeats: [
      seat("setup", "scout"),
      seat("punchline", "advocate"),
      seat("prosecutor", "prosecutor"),
    ],
    createdAt: "2026-09-17T20:00:00.000Z",
    resolvedAt: "2026-09-17T20:01:00.000Z",
    reportedAt: null,
  };
  const member = (name: string, agentId: string) => ({
    seatName: name,
    agentId,
    participantId: ParticipantId.make(`agent:${name}`),
    threadId: ThreadId.make(`thread:${name}`),
    addedVersion: 1,
    reason: null,
  });
  const instance = {
    id: "crew:1",
    squadronId: SquadronId.make("squadron:1"),
    captainParticipantId: ParticipantId.make("agent:captain"),
    captainThreadId: ThreadId.make("thread:captain"),
    displayName: "Comedy",
    brief: "Tell two jokes.",
    version: 1,
    createdAt: "2026-09-17T20:01:00.000Z",
    archivedAt: null,
    members: [
      member("setup", "scout"),
      member("punchline", "advocate"),
      member("prosecutor", "prosecutor"),
    ],
  } as unknown as AgentCrewInstance;

  it("says per seat what became of its first turn, and what the person changed", () => {
    const text = crewLaunchReportText({
      proposal,
      instance,
      verdicts: new Map([
        ["setup", { kind: "started" }],
        [
          "punchline",
          {
            kind: "failed",
            runStatus: "failed",
            failure: {
              class: "provider_error",
              message: "API Error: Can't reach the API server",
              code: "sdk_result_error",
              retryable: null,
            },
          },
        ],
        ["prosecutor", { kind: "pending" }],
      ]),
      windowMs: 60_000,
    });
    assert.include(text, "decision: approved");
    assert.include(text, "changes: added prosecutor");
    assert.include(text, "launch: 1 started, 1 failed to start, 1 not started after 60s");
    assert.include(
      text,
      "seat_failed: punchline | failed | provider_error — API Error: Can't reach the API server",
    );
    assert.include(text, "seat_pending: prosecutor");
    assert.include(
      text,
      "- setup: participant_id=agent:setup agent=scout thread_id=thread:setup start=started",
    );
    assert.include(text, "thread_id=thread:punchline start=failed");
    assert.include(text, "thread_id=thread:prosecutor start=pending");
    assert.include(text, "1 of 3 seats failed to start");
    assert.include(text, "1 seat had not started after 60s");
    assert.notInclude(text, "Your crew is running");
  });

  it("reads as a running crew when every seat started, with no change against the proposal", () => {
    const text = crewLaunchReportText({
      proposal: { ...proposal, approvedSeats: proposal.requestedSeats },
      instance: { ...instance, members: instance.members.slice(0, 2) } as AgentCrewInstance,
      verdicts: new Map([
        ["setup", { kind: "started" }],
        ["punchline", { kind: "started" }],
      ]),
      windowMs: 60_000,
    });
    assert.include(text, "changes: none");
    assert.include(text, "launch: 2 started, 0 failed to start, 0 not started after 60s");
    assert.include(text, "Your crew is running.");
    assert.notInclude(text, "seat_failed");
  });
});

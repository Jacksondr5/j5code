import { describe, expect, it } from "vite-plus/test";

import {
  classifyCrewSeat,
  crewHasRunningSeat,
  formatCrewStateSummary,
  summarizeCrewState,
  type CrewSeatThread,
} from "./crewState";

const seat = (overrides: Partial<CrewSeatThread> = {}): CrewSeatThread => ({
  runtime: { status: "idle" },
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  updatedAt: "2026-09-14T10:00:00.000Z",
  ...overrides,
});

describe("crew state", () => {
  it("classifies each seat from measured facts in precedence order", () => {
    expect(classifyCrewSeat(undefined)).toBe("unknown");
    expect(classifyCrewSeat(seat({ archivedAt: "2026-09-14T09:00:00.000Z" }))).toBe("archived");
    expect(
      classifyCrewSeat(seat({ runtime: { status: "running" }, hasPendingApprovals: true })),
    ).toBe("running");
    expect(classifyCrewSeat(seat({ hasPendingUserInput: true, settledAt: "x" }))).toBe("needs-you");
    expect(classifyCrewSeat(seat({ settledAt: "2026-09-14T09:30:00.000Z" }))).toBe("settled");
    expect(classifyCrewSeat(seat({ settledOverride: "settled" }))).toBe("settled");
    // A user who reopened a settled seat made it active again.
    expect(classifyCrewSeat(seat({ settledOverride: "active", settledAt: "x" }))).toBe("idle");
    expect(classifyCrewSeat(seat())).toBe("idle");
  });

  it("summarizes a Crew and formats only the states worth saying", () => {
    const summary = summarizeCrewState([
      seat({ runtime: { status: "running" }, updatedAt: "2026-09-14T12:00:00.000Z" }),
      seat({ runtime: { status: "waiting" } }),
      seat({ hasPendingApprovals: true }),
      seat({ settledAt: "2026-09-14T09:30:00.000Z" }),
      seat(),
      undefined,
    ]);
    expect(summary.total).toBe(6);
    expect(summary.counts).toEqual({
      running: 2,
      "needs-you": 1,
      settled: 1,
      idle: 1,
      archived: 0,
      unknown: 1,
    });
    expect(summary.lastActivityAt).toBe("2026-09-14T12:00:00.000Z");
    expect(formatCrewStateSummary(summary)).toBe("2 running · 1 needs you · 1 settled · 1 unknown");
    expect(formatCrewStateSummary(summarizeCrewState([seat(), seat()]))).toBeNull();
    expect(crewHasRunningSeat(summary)).toBe(true);
    expect(
      crewHasRunningSeat(summarizeCrewState([seat(), seat({ hasPendingApprovals: true })])),
    ).toBe(false);
    expect(formatCrewStateSummary(summarizeCrewState([]))).toBeNull();
  });
});

import type {
  ArchiveWarningPayload,
  ArchiveWarningRow,
} from "@t3tools/client-runtime/j5/archive-flow";
import { describe, expect, it, vi } from "vite-plus/test";

import { formatArchiveWarningText } from "./archiveWarningText";

const name = (displayName: string) => ({ displayName, tooltipParticipantId: null });

const ask = (intent: string, openedAt = "2026-10-31T09:00:00.000Z"): ArchiveWarningRow => ({
  direction: "outbound",
  participant: name("Jackson (inbox)"),
  urgency: null,
  intent,
  openedAt,
});

const payload = (overrides: Partial<ArchiveWarningPayload>): ArchiveWarningPayload => ({
  threadTitle: "Billing agent",
  factsUnavailable: false,
  placement: { state: "none" },
  openAsks: [],
  crews: { state: "known", crews: [] },
  ...overrides,
});

describe("archive warning text", () => {
  it("lists a Captain's Crew seat by seat with what ends for each", () => {
    vi.setSystemTime(new Date("2026-10-31T12:00:00.000Z"));
    const text = formatArchiveWarningText(
      payload({
        placement: { state: "known", participants: [name("Helper")] },
        openAsks: [ask("Approve the schema")],
        crews: {
          state: "known",
          crews: [
            {
              crewInstanceId: "crew:1",
              crewName: "Review Pair",
              seats: [
                { seat: "builder", participant: name("Builder"), runningTurn: false, openAsks: 0 },
                { seat: "critic", participant: name("Critic"), runningTurn: true, openAsks: 1 },
              ],
            },
          ],
        },
      }),
    );
    vi.useRealTimers();
    expect(text).toBe(
      [
        "A Captain is never archived alone. This Crew retires with it, every seat together:",
        "Crew · Review Pair (2 seats)",
        "  builder · Builder",
        "  critic · Critic: running turn, 1 open ask",
        "",
        "1 agent placed under Billing agent keeps running: Helper.",
        "",
        "1 open ask will be terminated (counterparty is notified):",
        "",
        "NO URGENCY · To Jackson (inbox) · open 3h",
        "“Approve the schema”",
        "",
        "Worktrees, branches, and pull requests remain. Cleanup is a separate action.",
      ].join("\n"),
    );
  });

  it("names each fact it couldn't check instead of an empty list", () => {
    const text = formatArchiveWarningText(
      payload({ placement: { state: "unknown" }, crews: { state: "unknown" } }),
    );
    expect(text).toContain("Placement subtree: couldn't check.");
    expect(text).toContain("Crews it commands: couldn't check.");
  });

  it("keeps the full count when it cuts a long list of asks to fit the alert", () => {
    const text = formatArchiveWarningText(
      payload({ openAsks: Array.from({ length: 7 }, (_, index) => ask(`Ask ${index}`)) }),
    );
    expect(text).toContain("7 open asks will be terminated");
    expect(text).toContain("“Ask 4”");
    expect(text).not.toContain("“Ask 5”");
    expect(text).toContain("and 2 more");
  });

  it("cuts a long intent with an ellipsis", () => {
    const text = formatArchiveWarningText(payload({ openAsks: [ask("x".repeat(400))] }));
    expect(text).toContain(`“${"x".repeat(119)}…”`);
  });
});

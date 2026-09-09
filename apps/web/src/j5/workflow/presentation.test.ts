import { describe, expect, it } from "vite-plus/test";
import type { RunDetail } from "@j5/workflow-contracts";
import {
  exactAndRelativeTime,
  expectedNextStep,
  failureHeading,
  phaseLabel,
  statusPresentation,
} from "./presentation";

describe("workflow presentation", () => {
  it("gives every status a text label", () => {
    expect(statusPresentation.waiting_approval.label).toBe("Needs approval");
    expect(statusPresentation.cancelling.label).toBe("Cancelling");
  });

  it("keeps legacy activity honest", () => {
    expect(exactAndRelativeTime(undefined).relative).toBe("Activity time unavailable");
    expect(
      exactAndRelativeTime("2026-09-07T10:00:00.000Z", Date.parse("2026-09-07T10:03:00Z")).relative,
    ).toBe("Active 3m ago");
    expect(phaseLabel("publication_approval")).toBe("Publication approval");
  });

  it("presents timed-out and cleanup failures with their available action", () => {
    const restartAvailability = {
      available: true,
      reason: "Restart is available.",
      targetDefinitionHash: "new",
      nextVisit: 2,
      maxVisits: 3,
      compatibleDefinitionUpgrade: true,
    };
    const timedOut = {
      phase: "plan_review",
      status: "blocked",
      failureCategory: "action_deadline_expired",
      recovery: null,
      restartAvailability,
    } as unknown as RunDetail;
    expect(expectedNextStep(timedOut)).toBe("Restart plan review");
    expect(
      expectedNextStep({
        ...timedOut,
        recovery: "retry_restart",
        restartAvailability: { ...restartAvailability, available: false },
      }),
    ).toBe("Retry reviewer cleanup");
    expect(failureHeading({ ...timedOut, failureCategory: "restart_cleanup_failed" })).toBe(
      "Reviewer cleanup failed",
    );
  });
});

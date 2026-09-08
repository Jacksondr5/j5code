import { describe, expect, it } from "vite-plus/test";
import { exactAndRelativeTime, phaseLabel, statusPresentation } from "./presentation";

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
});

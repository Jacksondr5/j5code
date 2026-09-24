import { assert, it } from "@effect/vitest";

import { COUNT_POLL_INTERVAL_MS, shouldShowOpenInboxCount } from "./HumanInboxBell";

it("shows only positive known open counts", () => {
  assert.equal(shouldShowOpenInboxCount(null), false);
  assert.equal(shouldShowOpenInboxCount(0), false);
  assert.equal(shouldShowOpenInboxCount(3), true);
});

it("keeps the open-count poll inside the authorized aggressive window", () => {
  assert.isAtLeast(COUNT_POLL_INTERVAL_MS, 5_000);
  assert.isAtMost(COUNT_POLL_INTERVAL_MS, 10_000);
});

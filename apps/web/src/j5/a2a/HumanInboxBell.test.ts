import { assert, it } from "@effect/vitest";

import {
  COUNT_POLL_INTERVAL_MS,
  observeApprovalGates,
  shouldShowOpenInboxCount,
  type GateNotificationState,
} from "./HumanInboxBell";

it("shows only positive known open counts", () => {
  assert.equal(shouldShowOpenInboxCount(null), false);
  assert.equal(shouldShowOpenInboxCount(0), false);
  assert.equal(shouldShowOpenInboxCount(3), true);
});

it("keeps the open-count poll inside the authorized aggressive window", () => {
  assert.isAtLeast(COUNT_POLL_INTERVAL_MS, 5_000);
  assert.isAtMost(COUNT_POLL_INTERVAL_MS, 10_000);
});

it("silently baselines approval gates and ignores unchanged snapshots", () => {
  const first = observeApprovalGates(null, "environment-1", [
    { id: "run-1", gateRevision: 1 },
  ]);
  assert.isFalse(first.shouldNotify);

  const unchanged = observeApprovalGates(first.state, "environment-1", [
    { id: "run-1", gateRevision: 1 },
  ]);
  assert.isFalse(unchanged.shouldNotify);
});

it("requests one notification for new runs and higher gate revisions", () => {
  let state: GateNotificationState | null = observeApprovalGates(null, "environment-1", [
    { id: "run-1", gateRevision: 1 },
  ]).state;

  const newRun = observeApprovalGates(state, "environment-1", [
    { id: "run-1", gateRevision: 1 },
    { id: "run-2", gateRevision: 1 },
    { id: "run-3", gateRevision: 1 },
  ]);
  assert.isTrue(newRun.shouldNotify);
  state = newRun.state;

  const unchanged = observeApprovalGates(state, "environment-1", [
    { id: "run-1", gateRevision: 1 },
    { id: "run-2", gateRevision: 1 },
    { id: "run-3", gateRevision: 1 },
  ]);
  assert.isFalse(unchanged.shouldNotify);

  const higherRevision = observeApprovalGates(unchanged.state, "environment-1", [
    { id: "run-1", gateRevision: 2 },
    { id: "run-2", gateRevision: 1 },
    { id: "run-3", gateRevision: 1 },
  ]);
  assert.isTrue(higherRevision.shouldNotify);

  const newEnvironment = observeApprovalGates(higherRevision.state, "environment-2", [
    { id: "run-3", gateRevision: 1 },
  ]);
  assert.isFalse(newEnvironment.shouldNotify);
});

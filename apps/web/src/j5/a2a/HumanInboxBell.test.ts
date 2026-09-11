import { assert, it } from "@effect/vitest";

import {
  COUNT_POLL_INTERVAL_MS,
  observeWorkflowGates,
  shouldShowOpenInboxCount,
} from "./HumanInboxBell";

const gate = (id: string, gateRevision: number | null) => ({ id, gateRevision });

it("shows only positive known open counts", () => {
  assert.equal(shouldShowOpenInboxCount(null), false);
  assert.equal(shouldShowOpenInboxCount(0), false);
  assert.equal(shouldShowOpenInboxCount(3), true);
});

it("keeps the open-count poll inside the authorized aggressive window", () => {
  assert.isAtLeast(COUNT_POLL_INTERVAL_MS, 5_000);
  assert.isAtMost(COUNT_POLL_INTERVAL_MS, 10_000);
});

it("rings only for newly observed gate revisions in the current environment", () => {
  const observations: ReadonlyArray<{
    readonly name: string;
    readonly environmentId: string;
    readonly runs: ReadonlyArray<{ readonly id: string; readonly gateRevision: number | null }>;
    readonly shouldRing: boolean;
    readonly seen: ReadonlyArray<readonly [string, number]>;
  }> = [
    {
      name: "initial baseline",
      environmentId: "environment-a",
      runs: [gate("run-a", 1)],
      shouldRing: false,
      seen: [["run-a", 1]],
    },
    {
      name: "unchanged gate",
      environmentId: "environment-a",
      runs: [gate("run-a", 1)],
      shouldRing: false,
      seen: [["run-a", 1]],
    },
    {
      name: "batched arrivals",
      environmentId: "environment-a",
      runs: [gate("run-a", 1), gate("run-b", 2), gate("run-c", 3)],
      shouldRing: true,
      seen: [
        ["run-a", 1],
        ["run-b", 2],
        ["run-c", 3],
      ],
    },
    {
      name: "removal",
      environmentId: "environment-a",
      runs: [gate("run-a", 1), gate("run-c", 3)],
      shouldRing: false,
      seen: [
        ["run-a", 1],
        ["run-b", 2],
        ["run-c", 3],
      ],
    },
    {
      name: "returning gate",
      environmentId: "environment-a",
      runs: [gate("run-a", 1), gate("run-b", 2), gate("run-c", 3)],
      shouldRing: false,
      seen: [
        ["run-a", 1],
        ["run-b", 2],
        ["run-c", 3],
      ],
    },
    {
      name: "same-count replacement",
      environmentId: "environment-a",
      runs: [gate("run-c", 3), gate("run-d", 1), gate("run-e", null)],
      shouldRing: true,
      seen: [
        ["run-a", 1],
        ["run-b", 2],
        ["run-c", 3],
        ["run-d", 1],
      ],
    },
    {
      name: "higher gate revision",
      environmentId: "environment-a",
      runs: [gate("run-c", 4), gate("run-d", 1)],
      shouldRing: true,
      seen: [
        ["run-a", 1],
        ["run-b", 2],
        ["run-c", 4],
        ["run-d", 1],
      ],
    },
    {
      name: "environment reset",
      environmentId: "environment-b",
      runs: [gate("run-e", 1)],
      shouldRing: false,
      seen: [["run-e", 1]],
    },
  ];

  let state = null;
  for (const observation of observations) {
    const result = observeWorkflowGates(state, observation.environmentId, observation.runs);
    assert.equal(result.shouldRing, observation.shouldRing, observation.name);
    assert.deepEqual([...result.state.seenGateRevisions], observation.seen, observation.name);
    state = result.state;
  }
});

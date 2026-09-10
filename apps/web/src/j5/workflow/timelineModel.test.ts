import { assert, it } from "@effect/vitest";

import { detectDissent, groupTimelineLanes, type TimelineDisplayEntry } from "./timelineModel";

const entry = (
  revision: number,
  kind: TimelineDisplayEntry["kind"],
  extra: Partial<TimelineDisplayEntry> = {},
): TimelineDisplayEntry => ({
  id: `${revision}:0`,
  revision,
  recordedAt: "2026-09-09T00:00:00Z",
  partial: false,
  kind,
  phase: null,
  visit: null,
  ...extra,
});

it("groups entries into stable lanes without changing revision order", () => {
  const entries = [
    entry(5, "decision", { gateRevision: 4 }),
    entry(4, "action_completed", { actionKind: "agent", task: "Reviewer" }),
    entry(3, "action_queued", { actionKind: "code", task: "Build" }),
    entry(2, "blocked"),
  ];
  const lanes = groupTimelineLanes(entries);
  assert.deepEqual(
    lanes.map(({ lane, entries: laneEntries }) => [
      lane,
      laneEntries.map(({ revision }) => revision),
    ]),
    [
      ["agent", [4]],
      ["code", [3]],
      ["gate", [5]],
      ["run", [2]],
    ],
  );
});

it("detects reviewer dissent and a later human override", () => {
  const entries = [
    entry(5, "decision", { decision: "approve", actor: "human", gateRevision: 4 }),
    entry(4, "gate_opened", { phase: "plan_approval", gateRevision: 4 }),
    entry(3, "phase_entered", { phase: "plan_approval" }),
    entry(2, "action_completed", {
      actionKind: "agent",
      phase: "plan_review",
      task: "Architecture reviewer",
      verdict: "revise",
    }),
  ];
  assert.deepEqual(detectDissent(entries), [
    {
      gateRevision: 4,
      phase: "plan_review",
      reviewers: ["Architecture reviewer"],
      overriddenBy: "human",
    },
  ]);
});

it("keeps partial entries ordered even when timestamps are unavailable", () => {
  const entries = [entry(3, "event", { recordedAt: null, partial: true }), entry(2, "event")];
  assert.deepEqual(
    groupTimelineLanes(entries)[0]?.entries.map(({ revision }) => revision),
    [3, 2],
  );
});

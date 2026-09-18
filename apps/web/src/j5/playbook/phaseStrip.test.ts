import { assert, it } from "@effect/vitest";

import { phaseStripModel } from "./phaseStrip";

const phases = [
  { id: "plan", kind: "agent", maxVisits: 2, transitions: {} },
  { id: "approval", kind: "gate", maxVisits: 2, transitions: {} },
  { id: "build", kind: "code", maxVisits: 1, transitions: {} },
] as const;

it("marks visited, current, revisited, pending, and blocked phases", () => {
  assert.deepEqual(
    phaseStripModel(phases, { plan: 2, approval: 1 }, "approval", "waiting_approval").cells.map(
      ({ id, state }) => ({ id, state }),
    ),
    [
      { id: "plan", state: "revisited" },
      { id: "approval", state: "current" },
      { id: "build", state: "pending" },
    ],
  );
  assert.equal(phaseStripModel(phases, { plan: 1 }, "plan", "blocked").current?.state, "blocked");
  assert.equal(phaseStripModel(phases, { plan: 1 }, "approval", "running").cells[0]?.state, "done");
});

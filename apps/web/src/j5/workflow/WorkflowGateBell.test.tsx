import { assert, it } from "@effect/vitest";

import {
  observeWorkflowGates,
  playWorkflowGateBell,
  readWorkflowGateLedger,
  workflowGateStorageKey,
  writeWorkflowGateLedger,
} from "./WorkflowGateBell";

const run = (status: "running" | "waiting_approval", gateRevision: number | null, id = "run") => ({
  id,
  status,
  gateRevision,
});

const createStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

it("silently baselines the first workflow snapshot", () => {
  const observed = observeWorkflowGates({}, [run("waiting_approval", 3)], false);

  assert.deepEqual(observed.ledger, { run: 3 });
  assert.equal(observed.newGateCount, 0);
});

it("notifies once when a workflow reaches an approval gate", () => {
  const baseline = observeWorkflowGates({}, [run("running", null)], false);
  const reached = observeWorkflowGates(baseline.ledger, [run("waiting_approval", 3)], true);
  const unchanged = observeWorkflowGates(reached.ledger, [run("waiting_approval", 3)], true);

  assert.equal(reached.newGateCount, 1);
  assert.equal(unchanged.newGateCount, 0);
  assert.strictEqual(unchanged.ledger, reached.ledger);
});

it("notifies again for a later gate revision on the same workflow", () => {
  const previous = { run: 3 };
  const observed = observeWorkflowGates(previous, [run("waiting_approval", 7)], true);

  assert.deepEqual(observed.ledger, { run: 7 });
  assert.equal(observed.newGateCount, 1);
});

it("persists gate identities separately for each environment", () => {
  const storage = createStorage();
  writeWorkflowGateLedger(storage, "environment:one", { run: 3 });
  writeWorkflowGateLedger(storage, "environment:two", { run: 7 });

  assert.notEqual(
    workflowGateStorageKey("environment:one"),
    workflowGateStorageKey("environment:two"),
  );
  assert.deepEqual(readWorkflowGateLedger(storage, "environment:one"), { run: 3 });
  assert.deepEqual(readWorkflowGateLedger(storage, "environment:two"), { run: 7 });
});

it("ignores unavailable and blocked Web Audio", async () => {
  assert.isFalse(await playWorkflowGateBell(() => undefined));

  const blocked = {
    state: "suspended",
    resume: () => Promise.reject(new Error("autoplay blocked")),
    close: () => Promise.resolve(),
  } as unknown as AudioContext;
  assert.isFalse(await playWorkflowGateBell(() => blocked));
});

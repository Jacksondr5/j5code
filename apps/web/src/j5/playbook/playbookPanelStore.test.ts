import { assert, beforeEach, it } from "@effect/vitest";

import { effectivePlaybookPanelOffset, usePlaybookPanelStore } from "./playbookPanelStore";

beforeEach(() =>
  usePlaybookPanelStore.setState({ selectedRunId: null, scope: "", offset: 0, tab: "overview" }),
);

it("shares selection and restores only the most recently paged scope", () => {
  const store = usePlaybookPanelStore.getState();
  store.selectRun("environment-a", "run-a");
  store.setOffset("A", 20);
  assert.equal(effectivePlaybookPanelOffset(usePlaybookPanelStore.getState(), "A"), 20);
  assert.equal(effectivePlaybookPanelOffset(usePlaybookPanelStore.getState(), "B"), 0);
  assert.equal(effectivePlaybookPanelOffset(usePlaybookPanelStore.getState(), "A"), 20);
  usePlaybookPanelStore.getState().setOffset("B", 40);
  assert.equal(effectivePlaybookPanelOffset(usePlaybookPanelStore.getState(), "A"), 0);
  assert.equal(usePlaybookPanelStore.getState().selectedRunId, "run-a");
  assert.equal(usePlaybookPanelStore.getState().selectedEnvironmentId, "environment-a");
});

it("resets the detail tab when selection changes", () => {
  usePlaybookPanelStore.getState().setTab("timeline");
  usePlaybookPanelStore.getState().selectRun("environment-b", "run-b");
  assert.equal(usePlaybookPanelStore.getState().tab, "overview");
});

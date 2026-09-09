import { assert, beforeEach, it } from "@effect/vitest";

import { effectiveWorkflowPanelOffset, useWorkflowPanelStore } from "./workflowPanelStore";

beforeEach(() => useWorkflowPanelStore.setState({ selectedRunId: null, scope: "", offset: 0 }));

it("shares selection and restores only the most recently paged scope", () => {
  const store = useWorkflowPanelStore.getState();
  store.selectRun("run-a");
  store.setOffset("A", 20);
  assert.equal(effectiveWorkflowPanelOffset(useWorkflowPanelStore.getState(), "A"), 20);
  assert.equal(effectiveWorkflowPanelOffset(useWorkflowPanelStore.getState(), "B"), 0);
  assert.equal(effectiveWorkflowPanelOffset(useWorkflowPanelStore.getState(), "A"), 20);
  useWorkflowPanelStore.getState().setOffset("B", 40);
  assert.equal(effectiveWorkflowPanelOffset(useWorkflowPanelStore.getState(), "A"), 0);
  assert.equal(useWorkflowPanelStore.getState().selectedRunId, "run-a");
});

import { assert, it } from "@effect/vitest";

import { shouldApplyWorkflowMutation } from "./useWorkflowRunDetail";

it("applies mutation responses only to the selection that originated them", () => {
  assert.isTrue(shouldApplyWorkflowMutation("run-a", "run-a", "run-a"));
  assert.isFalse(shouldApplyWorkflowMutation("run-a", "run-b", "run-a"));
  assert.isFalse(shouldApplyWorkflowMutation("run-a", "run-a", "run-b"));
});

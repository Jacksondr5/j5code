import { assert, it } from "@effect/vitest";

import { shouldApplyPlaybookMutation } from "./usePlaybookRunDetail";

it("applies mutation responses only to the selection that originated them", () => {
  assert.isTrue(shouldApplyPlaybookMutation("run-a", "run-a", "run-a"));
  assert.isFalse(shouldApplyPlaybookMutation("run-a", "run-b", "run-a"));
  assert.isFalse(shouldApplyPlaybookMutation("run-a", "run-a", "run-b"));
});

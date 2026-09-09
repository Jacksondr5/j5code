import { assert, it, vi } from "@effect/vitest";

import { commandAttemptFor } from "./useCreateWorkflow";

it("reuses a command id for unchanged creation payloads and replaces it for changed payloads", () => {
  const randomUUID = vi.fn().mockReturnValueOnce("one").mockReturnValueOnce("two");
  const first = commandAttemptFor(null, "payload-a", randomUUID);
  const retry = commandAttemptFor(first, "payload-a", randomUUID);
  const changed = commandAttemptFor(retry, "payload-b", randomUUID);
  assert.strictEqual(retry, first);
  assert.equal(changed.commandId, "two");
  assert.equal(randomUUID.mock.calls.length, 2);
});

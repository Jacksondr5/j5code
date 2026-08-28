import { assert, it, vi } from "@effect/vitest";

import { submitHumanInboxAnswer } from "./HumanInboxPage";
import type { HumanInboxItem } from "./humanInboxClient";

it("clears pending state when answer attempt id generation fails", async () => {
  const item = {
    personId: "human:local-operator",
    squadronId: "squadron:answer-test",
    squadronName: "Answer test",
    exchangeId: "exchange:answer-test",
    senderId: "agent:answer-test",
    intent: "Prove pending cleanup",
    urgency: "blocking",
    message: "Question",
    openedAt: "2026-08-27T00:00:00.000Z",
  } satisfies HumanInboxItem;
  const pending: Array<string | null> = [];
  const errors: Array<string | null> = [];
  const send = vi.fn(async () => undefined);
  const refresh = vi.fn(async () => undefined);
  const onAccepted = vi.fn();

  await submitHumanInboxAnswer({
    item,
    message: "Answer",
    attempts: new Map(),
    randomUUID: () => {
      throw new Error("Secure random ids are unavailable.");
    },
    send,
    refresh,
    onAccepted,
    setPendingExchangeId: (exchangeId) => pending.push(exchangeId),
    setError: (message) => errors.push(message),
  });

  assert.deepStrictEqual(pending, [item.exchangeId, null]);
  assert.deepStrictEqual(errors, [null, "Secure random ids are unavailable."]);
  assert.equal(send.mock.calls.length, 0);
  assert.equal(refresh.mock.calls.length, 0);
  assert.equal(onAccepted.mock.calls.length, 0);
});

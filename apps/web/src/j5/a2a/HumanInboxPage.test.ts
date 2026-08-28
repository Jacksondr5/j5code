import { assert, it, vi } from "@effect/vitest";

import { captureHumanInboxAnswer, submitHumanInboxAnswer } from "./HumanInboxPage";
import type { HumanInboxItem } from "./humanInboxClient";

it("captures typed answer text before the state updater runs", () => {
  const event: { currentTarget: { value: string } | null } = {
    currentTarget: { value: "Verbatim answer" },
  };
  let update:
    | ((current: Readonly<Record<string, string>>) => Readonly<Record<string, string>>)
    | undefined;

  captureHumanInboxAnswer(
    event as { readonly currentTarget: { readonly value: string } },
    "exchange:deferred-update",
    (next) => {
      update = next;
    },
  );
  event.currentTarget = null;

  assert.deepStrictEqual(update?.({ existing: "Kept" }), {
    existing: "Kept",
    "exchange:deferred-update": "Verbatim answer",
  });
});

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

it("reports a stale inbox without treating a delivered answer as failed", async () => {
  const item = {
    personId: "human:local-operator",
    squadronId: "squadron:refresh-test",
    squadronName: "Refresh test",
    exchangeId: "exchange:refresh-test",
    senderId: "agent:refresh-test",
    intent: "Distinguish delivery from refresh",
    urgency: "blocking",
    message: "Question",
    openedAt: "2026-08-27T00:00:00.000Z",
  } satisfies HumanInboxItem;
  const attempts = new Map<string, { message: string; clientRequestId: string }>();
  const pending: Array<string | null> = [];
  const errors: Array<string | null> = [];
  const send = vi.fn(async () => undefined);
  const refresh = vi.fn(async () => {
    throw new Error("Network unavailable.");
  });
  const onAccepted = vi.fn();

  await submitHumanInboxAnswer({
    item,
    message: "Delivered answer",
    attempts,
    randomUUID: () => "request:refresh-test",
    send,
    refresh,
    onAccepted,
    setPendingExchangeId: (exchangeId) => pending.push(exchangeId),
    setError: (message) => errors.push(message),
  });

  assert.deepStrictEqual(pending, [item.exchangeId, null]);
  assert.deepStrictEqual(errors, [
    null,
    "Answer delivered, but the inbox could not be refreshed. The list may be stale.",
  ]);
  assert.equal(send.mock.calls.length, 1);
  assert.equal(refresh.mock.calls.length, 1);
  assert.equal(onAccepted.mock.calls.length, 1);
  assert.equal(attempts.has(item.exchangeId), false);
});

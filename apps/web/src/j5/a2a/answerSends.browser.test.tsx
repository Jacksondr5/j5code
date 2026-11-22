import { submitHumanInboxAnswer } from "@t3tools/client-runtime/j5/inbox";
import { EnvironmentId } from "@t3tools/contracts";
import type { ScopedHumanInboxItem } from "@t3tools/contracts/j5";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { type AnswerSends, answerSendCallbacks, retryAnswer, useAnswerSends } from "./answerSends";

function Harness(props: { readonly onRender: (sends: AnswerSends) => void }) {
  props.onRender(useAnswerSends());
  return null;
}

async function renderSends() {
  let sends: AnswerSends | undefined;
  // A hook harness with no links or navigation.
  const screen = await render(<Harness onRender={(value) => (sends = value)} />, { router: false });
  return { screen, current: () => sends! };
}

it("locks and reports each ask's send on its own, even when two sends overlap", async () => {
  const { screen, current } = await renderSends();
  await using _screen = screen;

  await act(() => {
    current().setPending("ask-a", true);
    current().setPending("ask-b", true);
  });
  await act(() => {
    current().setError("ask-a", { message: "Could not deliver the answer.", delivered: false });
    current().setPending("ask-a", false);
  });

  expect(current().isPending("ask-a")).toBe(false);
  expect(current().isPending("ask-b")).toBe(true);
  expect(current().errorOf("ask-a")?.message).toBe("Could not deliver the answer.");
  expect(current().errorOf("ask-b")).toBeNull();
});

it("only reads the Inbox again when trying again after the server took the answer", async () => {
  const { screen, current } = await renderSends();
  await using _screen = screen;
  const item = {
    environmentId: EnvironmentId.make("local"),
    personId: "owner",
    projectId: "project-1",
    exchangeId: "exchange-1",
  } as ScopedHumanInboxItem;
  const send = vi.fn(async () => undefined);
  const refresh = vi.fn(async () => {
    throw new Error("offline");
  });

  await act(() =>
    submitHumanInboxAnswer({
      item,
      message: "Ship it",
      attempts: new Map(),
      randomUUID: () => "request-1",
      send,
      refresh,
      notifyChanged: () => undefined,
      ...answerSendCallbacks(current(), "ask-a", () => undefined),
    }),
  );
  expect(current().errorOf("ask-a")?.delivered).toBe(true);

  const resend = vi.fn();
  const reread = vi.fn(async () => undefined);
  await act(() => retryAnswer(current(), "ask-a", { resend, reread }));

  expect(resend).not.toHaveBeenCalled();
  expect(reread).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
  expect(current().errorOf("ask-a")).toBeNull();
});

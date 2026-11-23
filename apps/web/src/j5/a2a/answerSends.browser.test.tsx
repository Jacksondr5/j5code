import { submitHumanInboxAnswer } from "@t3tools/client-runtime/j5/inbox";
import { EnvironmentId } from "@t3tools/contracts";
import type { ScopedHumanInboxItem } from "@t3tools/contracts/j5";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import {
  type AnswerSends,
  answerSendCallbacks,
  answerToDeliver,
  useAnswerSends,
} from "./answerSends";

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
  const item = {
    environmentId: EnvironmentId.make("local"),
    personId: "owner",
    projectId: "project-1",
    exchangeId: "exchange-1",
  } as ScopedHumanInboxItem;
  let failSend: (cause: Error) => void = () => undefined;
  const send = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => {
        failSend = reject;
      }),
  );

  await act(() => current().setPending("ask-b", true));
  let sending: Promise<void> = Promise.resolve();
  await act(() => {
    sending = submitHumanInboxAnswer({
      item,
      message: "Ship it",
      attempts: new Map(),
      randomUUID: () => "request-1",
      send,
      refresh: async () => undefined,
      notifyChanged: () => undefined,
      ...answerSendCallbacks(current(), "ask-a", () => undefined),
    });
  });
  expect(current().isPending("ask-a")).toBe(true);
  await act(async () => {
    failSend(new Error("Could not deliver the answer."));
    await sending;
  });

  expect(current().isPending("ask-a")).toBe(false);
  expect(current().isPending("ask-b")).toBe(true);
  expect(current().errorOf("ask-a")).toBe("Could not deliver the answer.");
  expect(current().errorOf("ask-b")).toBeNull();
});

it("delivers an answer exactly as typed, edge whitespace included, and a blank one not at all", () => {
  expect(answerToDeliver("  indented\nkeep the trailing space ")).toBe(
    "  indented\nkeep the trailing space ",
  );
  expect(answerToDeliver(" \n\t ")).toBeNull();
});

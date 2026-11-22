import { expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { type AnswerSends, useAnswerSends } from "./answerSends";

function Harness(props: { readonly onRender: (sends: AnswerSends) => void }) {
  props.onRender(useAnswerSends());
  return null;
}

it("locks and reports each ask's send on its own, even when two sends overlap", async () => {
  let sends: AnswerSends | undefined;
  await using _screen = await render(<Harness onRender={(value) => (sends = value)} />, {
    router: false,
  });
  const current = () => sends!;

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

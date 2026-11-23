import { expect, it, vi } from "vite-plus/test";

import { registerCommands } from "../../shortcuts/dispatcher";
import { render } from "../../../test/render";
import { useClaimedComposerShortcuts } from "./claimedComposerShortcuts";

function PinnedAsk() {
  return (
    <div>
      <input aria-label="Captain's prompt" />
      <div {...useClaimedComposerShortcuts()}>
        <textarea aria-label="Answer" />
        <button type="button">Attach</button>
      </div>
    </div>
  );
}

function pressModS(target: Element) {
  const event = new KeyboardEvent("keydown", {
    key: "s",
    metaKey: navigator.platform.includes("Mac"),
    ctrlKey: !navigator.platform.includes("Mac"),
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

it("keeps Mod+S typed in a pinned ask from stashing the Captain's prompt", async () => {
  // Nothing here links or navigates.
  await using screen = await render(<PinnedAsk />, { router: false });
  // The composer's stash scope, registered when it mounted, before the ask took focus.
  const stash = vi.fn((event: KeyboardEvent) => event.preventDefault());
  using _composer = {
    [Symbol.dispose]: registerCommands({ "composer.stash": stash }, { capture: true }),
  };
  const prompt = screen.getByRole("textbox", { name: "Captain's prompt" }).element();
  const answer = screen.getByRole("textbox", { name: "Answer" }).element() as HTMLElement;
  const attach = screen.getByRole("button", { name: "Attach" }).element() as HTMLElement;

  answer.focus();
  expect(pressModS(answer).defaultPrevented).toBe(true);
  attach.focus();
  pressModS(attach);
  expect(stash).not.toHaveBeenCalled();

  (prompt as HTMLElement).focus();
  pressModS(prompt);
  expect(stash).toHaveBeenCalledOnce();
});

const mod = navigator.platform.includes("Mac")
  ? { metaKey: true, ctrlKey: false }
  : { metaKey: false, ctrlKey: true };

it.each([
  ["Alt+Up", "thread.editQueuedMessage", { key: "ArrowUp", altKey: true }],
  ["Mod+Shift+Enter", "thread.steerQueuedMessage", { key: "Enter", shiftKey: true, ...mod }],
] as const)(
  "keeps %s typed in a pinned ask from acting on the Captain's queued message",
  async (_name, command, keys) => {
    // Nothing here links or navigates.
    await using screen = await render(<PinnedAsk />, { router: false });
    // The thread's handler, which treats the ask's editor as the composer.
    const thread = vi.fn((event: KeyboardEvent) => event.preventDefault());
    using _thread = {
      [Symbol.dispose]: registerCommands(
        { [command]: thread },
        { capture: true, context: () => ({ composerFocus: true }) },
      ),
    };
    const answer = screen.getByRole("textbox", { name: "Answer" }).element() as HTMLElement;

    answer.focus();
    const event = new KeyboardEvent("keydown", { ...keys, bubbles: true, cancelable: true });
    answer.dispatchEvent(event);

    // The thread's own listener skips a key whose default is prevented.
    expect(event.defaultPrevented).toBe(true);
    expect(thread).not.toHaveBeenCalled();
  },
);

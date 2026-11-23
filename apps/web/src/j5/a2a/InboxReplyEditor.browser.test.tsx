import { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { ComposerPromptEditorHandle } from "../../components/ComposerPromptEditorTiptap";
import { updateClientSettings } from "../../hooks/useSettings";
import { render } from "../../../test/render";
import { InboxReplyEditor } from "./InboxReplyEditor";

function Reply(props: { readonly onSubmit: (value: string) => void; readonly readOnly?: boolean }) {
  const [value, setValue] = useState("");
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  return (
    <InboxReplyEditor
      ariaLabel="Answer"
      draftKey="ask-1"
      editorRef={editorRef}
      environmentId={EnvironmentId.make("local")}
      onChange={setValue}
      onSubmit={() => props.onSubmit(value)}
      placeholder="Type the answer"
      readOnly={props.readOnly ?? false}
      value={value}
    />
  );
}

it("sends on Enter, adds a line on Shift+Enter, and keeps the words exactly as typed", async () => {
  const onSubmit = vi.fn();
  // Nothing here links or navigates.
  await using screen = await render(<Reply onSubmit={onSubmit} />, { router: false });
  const editor = screen.getByRole("textbox", { name: "Answer" });

  await userEvent.click(editor);
  await userEvent.keyboard("Use **staging**, not @prod or $deploy");
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}/compact");
  expect(onSubmit).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");

  expect(onSubmit).toHaveBeenCalledWith("Use **staging**, not @prod or $deploy\n/compact");
});

it("keeps leading spaces and a trailing newline in what it sends", async () => {
  const onSubmit = vi.fn();
  // Nothing here links or navigates.
  await using screen = await render(<Reply onSubmit={onSubmit} />, { router: false });

  await userEvent.click(screen.getByRole("textbox", { name: "Answer" }));
  await userEvent.keyboard("  indented{Shift>}{Enter}{/Shift}{Enter}");

  expect(onSubmit).toHaveBeenCalledWith("  indented\n");
});

it("needs Mod+Enter to send when the send setting asks for it, and a bare Enter adds a line", async () => {
  await updateClientSettings({ sendShortcut: "mod-enter" });
  await using _reset = {
    [Symbol.asyncDispose]: () => updateClientSettings({ sendShortcut: "enter" }),
  };
  const onSubmit = vi.fn();
  // Nothing here links or navigates.
  await using screen = await render(<Reply onSubmit={onSubmit} />, { router: false });
  const editor = screen.getByRole("textbox", { name: "Answer" });

  await userEvent.click(editor);
  await userEvent.keyboard("first{Enter}second");
  expect(onSubmit).not.toHaveBeenCalled();
  await userEvent.keyboard(
    navigator.platform.includes("Mac") ? "{Meta>}{Enter}{/Meta}" : "{Control>}{Enter}{/Control}",
  );

  expect(onSubmit).toHaveBeenCalledWith("first\nsecond");
});

it("takes no input when read-only", async () => {
  const onSubmit = vi.fn();
  // Nothing here links or navigates.
  await using screen = await render(<Reply onSubmit={onSubmit} readOnly />, { router: false });
  const editor = screen.getByRole("textbox", { name: "Answer" });

  await userEvent.click(editor);
  await userEvent.keyboard("words{Enter}");

  await expect.element(editor).toHaveAttribute("aria-readonly", "true");
  expect(editor.element().textContent).toBe("");
  expect(onSubmit).not.toHaveBeenCalled();
});

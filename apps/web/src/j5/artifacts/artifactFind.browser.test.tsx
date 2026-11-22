import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import type { ChatComposerHandle } from "../../components/chat/ChatComposer";
import { useChatShortcuts } from "../../components/chat/useChatShortcuts";
import { artifactFindAreaProps, artifactsSurfaceProps, isArtifactFindKey } from "./artifactFind";

const findKeybindings: ResolvedKeybindingsConfig = [
  {
    command: "chat.find",
    shortcut: {
      key: "f",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
  },
  {
    command: "chat.find",
    shortcut: {
      key: "g",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
  },
];

// The chat's find handler as ChatView wires it, with the page's own keydown listener after it.
function Page(props: { threadFinds: string[]; reachedPage: string[] }) {
  useChatShortcuts({
    enabled: true,
    keybindings: findKeybindings,
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef: { current: {} as Partial<ChatComposerHandle> as ChatComposerHandle },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {
      "chat.find": ({ event }) => {
        if (isArtifactFindKey(event, document.activeElement)) return false;
        props.threadFinds.push("thread");
      },
    },
    fallback: () => undefined,
  });
  useEffect(() => {
    const record = (event: KeyboardEvent) => {
      if (!event.defaultPrevented) props.reachedPage.push(event.key);
    };
    window.addEventListener("keydown", record);
    return () => window.removeEventListener("keydown", record);
  }, [props.reachedPage]);
  return (
    <>
      <textarea aria-label="Composer" />
      <main {...artifactsSurfaceProps}>
        <button type="button">Artifact file</button>
        <div {...artifactFindAreaProps} aria-label="Artifact preview" tabIndex={-1}>
          <p>Artifact text</p>
        </div>
      </main>
    </>
  );
}

// router: false because nothing here navigates.
const options = { router: false } as const;

it.each([
  { click: "the artifact list", target: "Artifact file", key: "f", threadFinds: [], native: true },
  {
    click: "the artifact's text",
    target: "Artifact text",
    key: "f",
    threadFinds: [],
    native: true,
  },
  { click: "the composer", target: "Composer", key: "f", threadFinds: ["thread"], native: false },
  // Another chord bound to thread find keeps it in the artifact.
  {
    click: "the artifact's text",
    target: "Artifact text",
    key: "g",
    threadFinds: ["thread"],
    native: false,
  },
])("Ctrl+$key after clicking $click", async ({ target, key, threadFinds, native }) => {
  const finds: string[] = [];
  const reachedPage: string[] = [];
  await using screen = await render(
    <Page threadFinds={finds} reachedPage={reachedPage} />,
    options,
  );

  await userEvent.click(
    target === "Composer" ? screen.getByLabelText(target) : screen.getByText(target),
  );
  await userEvent.keyboard(`{Control>}${key}{/Control}`);

  expect(finds).toEqual(threadFinds);
  // The browser opens its own find only for a key nobody prevented.
  expect(reachedPage.includes(key)).toBe(native);
});

it("Ctrl+F in an artifact on desktop opens the find bar over the preview", async () => {
  const opened: unknown[] = [];
  using _bridge = stubGlobal("desktopBridge", {
    setFindBar: async (area: unknown) => {
      opened.push(area);
    },
  });
  const finds: string[] = [];
  const reachedPage: string[] = [];
  await using screen = await render(
    <Page threadFinds={finds} reachedPage={reachedPage} />,
    options,
  );

  await userEvent.click(screen.getByText("Artifact text"));
  await userEvent.keyboard("{Control>}f{/Control}");

  const preview = screen.getByLabelText("Artifact preview").element().getBoundingClientRect();
  expect(opened).toEqual([
    { x: preview.x, y: preview.y, width: preview.width, height: preview.height },
  ]);
  expect(finds).toEqual([]);
  expect(reachedPage.includes("f")).toBe(false);
});

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useEffect } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { shouldRefocusComposerOnWindowFocus } from "../../components/ChatView.logic";
import type { ChatComposerHandle } from "../../components/chat/ChatComposer";
import { useChatShortcuts } from "../../components/chat/useChatShortcuts";
import { ScrollArea } from "../../components/ui/scroll-area";
import { isPreviewFocused } from "../../lib/previewFocus";
import { artifactFindAreaProps, artifactsSurfaceProps } from "./artifactFind";

// ChatView's shortcuts with the default bindings, the Artifacts tab inside the right panel, and
// the page's own keydown listener after them.
function Page(props: { threadFinds: string[]; reachedPage: string[] }) {
  useChatShortcuts({
    enabled: true,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: isPreviewFocused(),
      previewOpen: true,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef: { current: {} as Partial<ChatComposerHandle> as ChatComposerHandle },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {
      "chat.find": () => {
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
      <aside data-preview-panel-mode="sidebar">
        <main {...artifactsSurfaceProps}>
          <button type="button">Artifact file</button>
          {/* ArtifactsPage's preview: Base UI's viewport is what a click on the text focuses. */}
          <ScrollArea {...artifactFindAreaProps} aria-label="Artifact preview">
            <p>Artifact text</p>
          </ScrollArea>
        </main>
      </aside>
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
])("Ctrl+$key on web after clicking $click", async ({ target, key, threadFinds, native }) => {
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

it("on desktop, opens the find bar by the physical F key only on a non-Latin layout", async () => {
  let opened = 0;
  using _bridge = stubGlobal("desktopBridge", {
    setFindBar: async () => {
      opened += 1;
    },
  });
  await using screen = await render(<Page threadFinds={[]} reachedPage={[]} />, options);
  await userEvent.click(screen.getByText("Artifact text"));
  const press = (init: KeyboardEventInit) =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, ...init }),
    );

  expect(press({ key: "а", code: "KeyF" })).toBe(false);
  expect(opened).toBe(1);
  // Dvorak's "u" sits on the physical F key.
  expect(press({ key: "u", code: "KeyF" })).toBe(true);
  expect(opened).toBe(1);
});

it("keeps focus in the artifact's preview when the window regains focus", async () => {
  await using screen = await render(<Page threadFinds={[]} reachedPage={[]} />, options);
  await userEvent.click(screen.getByText("Artifact text"));

  expect(document.activeElement?.getAttribute("data-slot")).toBe("scroll-area-viewport");
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
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

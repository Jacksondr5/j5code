import { expect, it, vi } from "vite-plus/test";

import { makeWorkspaceFileDropHandlers } from "../../components/chat/workspaceFileDrop";
import { ownFileDropTargetProps } from "./answerFileDrop";

it("leaves a file dropped on a pinned ask to the ask, and still clears the thread's drop overlay", () => {
  const host = { setDragActive: vi.fn(), addFiles: vi.fn(), addFolders: vi.fn() };
  const handlers = makeWorkspaceFileDropHandlers(host);
  const thread = document.createElement("div");
  const ask = document.createElement("div");
  for (const [name, value] of Object.entries(ownFileDropTargetProps)) ask.setAttribute(name, value);
  const answerBox = document.createElement("textarea");
  ask.append(answerBox);
  thread.append(ask, document.createElement("p"));
  const file = new File(["notes"], "notes.txt", { type: "text/plain" });
  const drop = (target: Element) =>
    handlers.onDrop({
      dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" },
      target,
      relatedTarget: null,
      currentTarget: thread,
      preventDefault: () => undefined,
    });

  drop(answerBox);
  expect(host.setDragActive).toHaveBeenLastCalledWith(false);
  expect(host.addFiles).not.toHaveBeenCalled();

  drop(thread.lastElementChild!);
  expect(host.addFiles).toHaveBeenCalledWith([file]);
});

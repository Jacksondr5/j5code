import type { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type { PresentedHumanInboxItem } from "@t3tools/client-runtime/j5/inbox";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const { environmentId, project, senderThread } = vi.hoisted(() => {
  const environmentId = "env-inbox" as EnvironmentId;
  const project = {
    id: "project-inbox",
    environmentId,
    workspaceRoot: "/repo",
    repositoryIdentity: {
      provider: "github",
      canonicalKey: "github.com/effect-ts/effect",
      displayName: "Effect-TS/effect",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/Effect-TS/effect.git",
      },
    },
  };
  const senderThread = { id: "thread-sender", projectId: project.id, worktreePath: null };
  return { environmentId, project, senderThread };
});

const { openUrlInPreview } = vi.hoisted(() => ({ openUrlInPreview: vi.fn() }));
vi.mock(import("../../browser/openFileInPreview"), async (original) => ({
  ...(await original()),
  openUrlInPreview: openUrlInPreview as never,
}));
vi.mock(import("../../browser/previewRuntime"), async (original) => ({
  ...(await original()),
  isPreviewAvailableFor: () => true,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProject: (() => project) as never,
  useProjects: (() => [project]) as never,
  readProjects: (() => [project]) as never,
  readProject: (() => project) as never,
  useThreadShell: (() => senderThread) as never,
  readThreadShell: (() => senderThread) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    environmentServerConfigsAtom: Atom.make(
      new Map([[environmentId, { environment: {} }]]),
    ) as never,
  };
});
vi.mock(import("../../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (id: unknown, scope: string) => id !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});

import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { useRightPanelStore } from "../../rightPanelStore";
import { InboxMessage } from "./HumanInboxPage";

const item = {
  environmentId,
  projectId: project.id,
  senderThreadId: senderThread.id,
  message: [
    "[the docs](https://example.com/docs)",
    "",
    "https://github.com/Effect-TS/effect/pull/7",
  ].join("\n"),
} as PresentedHumanInboxItem;

// The Inbox renders a message with its sender's thread, whose right panel isn't on screen.
it("opens an Inbox message's web links outside the sender thread's panel", async () => {
  openUrlInPreview.mockReset();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    browserLinkTarget: "app",
    pullRequestLinksOpenInApp: true,
  });
  await using screen = await render(<InboxMessage item={item} />, { router: "/inbox" });
  using openPullRequest = vi
    .spyOn(useRightPanelStore.getState(), "openPullRequest")
    .mockImplementation(() => {});
  const defaults: boolean[] = [];
  // Records whether the app took over the click, then keeps the browser from opening a tab.
  const recordDefault = (event: MouseEvent) => {
    defaults.push(event.defaultPrevented);
    event.preventDefault();
  };
  window.addEventListener("click", recordDefault);
  using _listener = { [Symbol.dispose]: () => window.removeEventListener("click", recordDefault) };

  const docsLink = screen.getByRole("link", { name: /the docs/ }).element();
  expect(docsLink.getAttribute("target")).toBe("_blank");
  expect(docsLink.getAttribute("rel")).toBe("noopener noreferrer");
  await act(() =>
    docsLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
  );
  expect(defaults).toEqual([false]);
  expect(openUrlInPreview).not.toHaveBeenCalled();

  await act(() =>
    screen
      .getByRole("link", { name: "https://github.com/Effect-TS/effect/pull/7" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
  );
  expect(openPullRequest).not.toHaveBeenCalled();
  expect(screen.router?.state.location.pathname).toBe("/pull-requests");
  expect(screen.router?.state.location.search).toMatchObject({
    repository: "effect-ts/effect",
    number: 7,
    selectedProjectId: project.id,
    selectedEnvironmentId: environmentId,
  });
});

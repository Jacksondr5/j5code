import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type { PresentedHumanInboxItem } from "@t3tools/client-runtime/j5/inbox";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const { environmentId, project, senderThread, threads } = vi.hoisted(() => {
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
  const senderThread = {
    id: "thread-sender",
    projectId: project.id,
    title: "Sender",
    worktreePath: null as string | null,
  };
  // What the client holds for the sender thread: its shell, or only its loaded detail.
  const threads = {
    shell: senderThread as typeof senderThread | null,
    // `null` while the thread's detail is still loading.
    detail: senderThread as typeof senderThread | null,
    detailReads: [] as string[],
  };
  return { environmentId, project, senderThread, threads };
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
  useThreadShell: ((ref: unknown) => (ref === null ? null : threads.shell)) as never,
  readThreadShell: (() => threads.shell) as never,
}));
vi.mock(import("../../state/threads"), async (original) => {
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return {
    ...(await original()),
    useEnvironmentThread: ((_environmentId: unknown, threadId: string | null) => {
      if (threadId === null) return EMPTY_ENVIRONMENT_THREAD_STATE;
      threads.detailReads.push(threadId);
      return threads.detail === null
        ? { ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "synchronizing" }
        : { ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some({ thread: threads.detail }) };
    }) as never,
  };
});
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

const senderRef = scopeThreadRef(environmentId, ThreadId.make(senderThread.id));
const links = [
  "[the docs](https://example.com/docs)",
  "",
  "https://github.com/Effect-TS/effect/pull/7",
];

function item(overrides: Partial<PresentedHumanInboxItem> = {}) {
  return {
    environmentId,
    projectId: project.id,
    senderThreadId: senderThread.id,
    message: links.join("\n"),
    ...overrides,
  } as PresentedHumanInboxItem;
}

function setup(shell: typeof threads.shell = senderThread) {
  threads.shell = shell;
  threads.detail = senderThread;
  threads.detailReads = [];
  openUrlInPreview.mockReset();
  openUrlInPreview.mockResolvedValue({ _tag: "Success", value: undefined });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    browserLinkTarget: "app",
    pullRequestLinksOpenInApp: true,
  });
}

// Records whether the app took over each click, then keeps the browser from opening a tab.
function recordClickDefaults() {
  const defaults: boolean[] = [];
  const record = (event: MouseEvent) => {
    defaults.push(event.defaultPrevented);
    event.preventDefault();
  };
  window.addEventListener("click", record);
  return { defaults, [Symbol.dispose]: () => window.removeEventListener("click", record) };
}

const click = (element: Element) =>
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

it("opens an Inbox message's links in the asking thread's own panel", async () => {
  setup();
  await using screen = await render(<InboxMessage item={item()} agentLabel="Builder" expanded />, {
    router: "/inbox",
  });
  using openPullRequest = vi
    .spyOn(useRightPanelStore.getState(), "openPullRequest")
    .mockImplementation(() => {});
  using _clicks = recordClickDefaults();

  await click(screen.getByRole("link", { name: /the docs/ }).element());
  await vi.waitFor(() =>
    expect(openUrlInPreview).toHaveBeenCalledWith(
      expect.objectContaining({ threadRef: senderRef, url: "https://example.com/docs" }),
    ),
  );

  await click(
    screen.getByRole("link", { name: "https://github.com/Effect-TS/effect/pull/7" }).element(),
  );
  expect(openPullRequest).toHaveBeenCalledWith(
    senderRef,
    expect.objectContaining({ repository: "effect-ts/effect", number: 7, projectId: project.id }),
  );
  expect(screen.router?.state.location.pathname).toBe("/inbox");
});

it("keeps links that need no panel when the asker has no thread here", async () => {
  setup();
  await using screen = await render(
    <InboxMessage item={item({ senderThreadId: null })} agentLabel="Builder" expanded />,
    { router: "/inbox" },
  );
  using openPullRequest = vi
    .spyOn(useRightPanelStore.getState(), "openPullRequest")
    .mockImplementation(() => {});
  using clicks = recordClickDefaults();

  const docsLink = screen.getByRole("link", { name: /the docs/ }).element();
  expect(docsLink.getAttribute("target")).toBe("_blank");
  await click(docsLink);
  expect(clicks.defaults).toEqual([false]);
  expect(openUrlInPreview).not.toHaveBeenCalled();

  await click(
    screen.getByRole("link", { name: "https://github.com/Effect-TS/effect/pull/7" }).element(),
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

it("loads the sender's thread for an open ask when the client holds no shell for it", async () => {
  setup(null);
  threads.detail = null;
  const message = (expanded: boolean) => (
    <InboxMessage
      item={item({ message: "See [app](src/app.ts)." })}
      agentLabel="Builder"
      expanded={expanded}
    />
  );
  // A collapsed ask reads nothing of its thread.
  await using screen = await render(message(false), { router: "/inbox" });
  await expect.element(screen.getByText(/See/)).toBeInTheDocument();
  expect(threads.detailReads).toEqual([]);

  // Opened, its links wait while the thread loads rather than open against the project root.
  await screen.rerender(message(true));
  expect(threads.detailReads).toContain(senderThread.id);
  const body = screen.container.querySelector("[aria-busy]");
  expect(body?.hasAttribute("inert")).toBe(true);

  threads.detail = { ...senderThread, worktreePath: "/worktrees/sender" };
  await screen.rerender(message(true));
  await expect
    .element(screen.getByRole("link", { name: /app/ }))
    .toHaveAttribute("href", expect.stringContaining("/worktrees/sender/src/app.ts"));
  expect(screen.container.querySelector("[inert]")).toBeNull();
});

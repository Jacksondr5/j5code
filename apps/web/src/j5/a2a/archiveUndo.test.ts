import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { threadEnvironment } from "../../state/threads";

// J5 (decision 7d): the archive door passes `undoable: false` when the archive may retire a
// Captain's Crews, because unarchiving would not bring the Crews back. Mirrors the setup of
// upstream's `hooks/useThreadActions.undo.test.ts`.
const archive = vi.hoisted(() => vi.fn());
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn(async () => {}), state: { matches: [{ params: {} }] } }),
}));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => false }));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: vi.fn(),
}));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  readThreadShell: () => ({
    title: "Captain",
    projectId: "project",
    environmentId: "undo-env",
    session: null,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === threadEnvironment.archive ? archive : vi.fn()),
}));

const target = {
  environmentId: EnvironmentId.make("undo-env"),
  threadId: ThreadId.make("thread"),
};

beforeEach(() => {
  vi.useFakeTimers();
  archive.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  useThreadUndoNotice.setState({ notice: null });
});

it("shows no Undo when the archive may have retired a Captain's Crews", async () => {
  await useThreadActions().archiveThread(target, { undoable: false });
  expect(archive).toHaveBeenCalledOnce();
  expect(useThreadUndoNotice.getState().notice).toBeNull();
});

it("keeps Undo for an ordinary archive", async () => {
  await useThreadActions().archiveThread(target);
  expect(archive).toHaveBeenCalledOnce();
  expect(useThreadUndoNotice.getState().notice).not.toBeNull();
});

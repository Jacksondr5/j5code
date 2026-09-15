import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
    text?: string;
    branch?: string | null;
    worktreePath?: string | null;
    envMode?: string;
    startFromOrigin?: boolean;
  } | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn((draftId: string) => ({
      text: draftId === storedDraft?.draftId ? (storedDraft.text ?? "") : "",
    })),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => null),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn((_draftId: string, context: object) => {
      Object.assign(storedDraft ?? {}, context);
    }),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };

  return {
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    reset(nextStoredDraft: typeof storedDraft) {
      storedDraft = nextStoredDraft;
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ defaultThreadEnvMode: "local", newWorktreesStartFromOrigin: false }),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({ DEFAULT_RUNTIME_MODE: "default" }));
vi.mock("@t3tools/shared/threadEnvMode", () => ({
  resolveDefaultThreadEnvMode: (input: {
    readonly projectFile: "local" | "worktree" | null;
    readonly globalDefault: "local" | "worktree";
  }) => input.projectFile ?? input.globalDefault,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: (draft: { text?: string }) => Boolean(draft.text),
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", () => ({
  hasExplicitComposerModelSelection: () => false,
  resolveNewDraftStartFromOrigin: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFileDefaultThreadEnvMode: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultThreadEnvMode: null,
      defaultModelSelection: null,
    },
  ],
  readThreadShell: () => null,
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/server", () => ({ primaryServerSettingsAtom: {} }));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import {
  launchCreatePlaybook,
  CREATE_PLAYBOOK_PROMPT,
} from "../j5/playbook/CreatePlaybookLauncher.logic";

import { useNewThreadHandler } from "./useHandleNewThread";

describe("useNewThreadHandler", () => {
  it("reuses an empty playbook draft in the selected checkout, clearing stale workspace context", async () => {
    const draft = {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
      branch: "old-branch",
      worktreePath: "/old/worktree",
      envMode: "worktree",
      startFromOrigin: true,
    };
    testState.reset(draft);
    const setPrompt = vi.fn();
    const opened = await launchCreatePlaybook({
      project: {
        id: "project-remote",
        environmentId: "environment-ssh",
        title: "Remote project",
        workspaceRoot: "/remote/project",
      } as never,
      openThread: useNewThreadHandler(),
      draftHasUserContent: () => false,
      setPrompt,
    });
    expect(opened?.draftId).toBe(draft.draftId);
    expect(draft).toMatchObject({
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
    });
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      { environmentId: "environment-ssh", projectId: "project-remote" },
      draft.draftId,
      expect.objectContaining({
        branch: null,
        worktreePath: null,
        envMode: "local",
        startFromOrigin: false,
      }),
    );
    expect(setPrompt).toHaveBeenCalledWith(draft.draftId, CREATE_PLAYBOOK_PROMPT);
  });

  it("preserves an invested draft and creates a fresh playbook draft in the selected checkout", async () => {
    const draft = {
      draftId: "draft-invested",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-invested",
      text: "Keep my work",
      branch: "my-branch",
      worktreePath: "/my/worktree",
      envMode: "worktree",
      startFromOrigin: true,
    };
    const before = { ...draft };
    testState.reset(draft);
    const setPrompt = vi.fn();
    const opened = await launchCreatePlaybook({
      project: {
        id: "project-remote",
        environmentId: "environment-ssh",
        title: "Remote project",
        workspaceRoot: "/remote/project",
      } as never,
      openThread: useNewThreadHandler(),
      draftHasUserContent: (draftId) =>
        Boolean(testState.draftStore.getComposerDraft(draftId).text),
      setPrompt,
    });
    expect(opened?.draftId).toBe("draft-delayed");
    expect(draft).toEqual(before);
    expect(setPrompt).toHaveBeenCalledWith("draft-delayed", CREATE_PLAYBOOK_PROMPT);
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      { environmentId: "environment-ssh", projectId: "project-remote" },
      "draft-delayed",
      expect.objectContaining({
        branch: null,
        worktreePath: null,
        envMode: "local",
        startFromOrigin: false,
      }),
    );
  });

  it.each([
    ["new", null],
    [
      "reusable",
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
      },
    ],
  ])("abandons a delayed %s draft open when the user navigates elsewhere", async (_, draft) => {
    testState.reset(draft);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });
});

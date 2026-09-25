import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { openPlaybookDraft } from "./openPlaybookDraft";

const workspace = {
  key: "remote:project",
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  threadId: null,
  title: "Project",
  workspaceRoot: "/remote/main",
  branch: null,
};
const draftId = DraftId.make("playbook-test-draft");
const threadId = ThreadId.make("reserved");
beforeEach(() =>
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  }),
);

it("prepares an ordinary draft in the selected environment's exact worktree", async () => {
  const target = {
    ...workspace,
    threadId: ThreadId.make("source"),
    workspaceRoot: "/remote/feature",
    branch: "feature",
  };
  await openPlaybookDraft(target, "Start playbook review", async (projectRef, options) => {
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(projectRef, draftId, { threadId, ...options });
    return { draftId, threadId };
  });
  const store = useComposerDraftStore.getState();
  expect(store.getDraftSession(draftId)).toMatchObject({
    environmentId: "remote",
    projectId: "project",
    worktreePath: "/remote/feature",
    branch: "feature",
    envMode: "local",
  });
  expect(store.getComposerDraft(draftId)?.prompt).toBe("Start playbook review");
});

it("preserves text entered during the asynchronous draft opening", async () => {
  let release: ((value: { draftId: DraftId; threadId: ThreadId }) => void) | undefined;
  const opening = openPlaybookDraft(
    workspace,
    "Replace this",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(
    scopeProjectRef(workspace.environmentId, workspace.projectId),
    draftId,
    { threadId },
  );
  store.setPrompt(draftId, "Keep my work");
  release!({ draftId, threadId });
  expect(await opening).toBe("preserved");
  expect(store.getComposerDraft(draftId)?.prompt).toBe("Keep my work");
});

it("leaves drafts untouched when opening is cancelled", async () => {
  const store = useComposerDraftStore.getState();
  store.setPrompt(draftId, "Keep my work");
  expect(await openPlaybookDraft(workspace, "Replace this", async () => null)).toBe("cancelled");
  expect(store.getComposerDraft(draftId)?.prompt).toBe("Keep my work");
});

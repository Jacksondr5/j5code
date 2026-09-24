import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { playbookWorkspaces } from "@t3tools/client-runtime/j5/playbooks";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/thread-outbox", () => ({
  threadOutboxManager: {},
  flushThreadOutbox: vi.fn(),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { isNewTaskDraftKey, parseLegacyNewTaskDraftKey } from "../../state/new-task-draft-key";
import {
  composerDraftsAtom,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  type ComposerDraft,
} from "../../state/use-composer-drafts";
import { preparePlaybookDraft } from "./preparePlaybookDraft";

const environmentId = EnvironmentId.make("environment:test");
const projectId = ProjectId.make("project:test");
const [project, worktree] = playbookWorkspaces(
  [{ environmentId, id: projectId, title: "Project", workspaceRoot: "/repo" }],
  [
    {
      environmentId,
      id: ThreadId.make("thread:owner"),
      projectId,
      title: "Existing conversation",
      worktreePath: "/repo/worktrees/review",
      branch: "review",
      deletedAt: null,
    },
  ],
);

beforeEach(() => {
  vi.useFakeTimers();
  appAtomRegistry.set(composerDraftsAtom, {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(composerDraftsAtom, {});
});

it.each([
  { workspace: project!, branch: null, worktreePath: null },
  { workspace: worktree!, branch: "review", worktreePath: "/repo/worktrees/review" },
])(
  "returns an openable draft containing the prompt and workspace $worktreePath",
  ({ workspace, branch, worktreePath }) => {
    const draftId = preparePlaybookDraft(workspace, "Start playbook review");

    expect(draftId).toEqual(expect.any(String));
    expect(isNewTaskDraftKey(draftId)).toBe(true);
    expect(parseLegacyNewTaskDraftKey(draftId)).toBeNull();
    expect(getComposerDraftSnapshot(draftId)).toEqual({
      text: "Start playbook review",
      attachments: [],
      project: { environmentId, projectId, createdAt: expect.any(String) },
      workspaceSelection: { mode: "local", branch, worktreePath, startFromOrigin: false },
    });
  },
);

it("preserves existing drafts and attachments when preparing multiple playbook chats", () => {
  const existingKey = createNewTaskDraft({ environmentId, projectId });
  const existing: ComposerDraft = {
    ...getComposerDraftSnapshot(existingKey),
    text: "Keep this idea",
    attachments: [
      {
        id: "attachment-1",
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        fileUri: "file:///documents/notes.txt",
      },
    ],
  };
  appAtomRegistry.set(composerDraftsAtom, { [existingKey]: existing });

  const first = preparePlaybookDraft(worktree!, "Start playbook review");
  const second = preparePlaybookDraft(project!, "Start playbook debugging");

  expect(new Set([existingKey, first, second]).size).toBe(3);
  expect(getComposerDraftSnapshot(existingKey)).toEqual(existing);
  expect(getComposerDraftSnapshot(first).text).toBe("Start playbook review");
  expect(getComposerDraftSnapshot(first).workspaceSelection?.worktreePath).toBe(
    "/repo/worktrees/review",
  );
  expect(getComposerDraftSnapshot(second).text).toBe("Start playbook debugging");
  expect(getComposerDraftSnapshot(second).workspaceSelection?.worktreePath).toBeNull();
});

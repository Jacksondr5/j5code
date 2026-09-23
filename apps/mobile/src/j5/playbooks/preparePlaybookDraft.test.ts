import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { playbookWorkspaces } from "@t3tools/client-runtime/j5/playbooks";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const drafts = vi.hoisted(() => ({
  text: "",
  update: vi.fn(),
  setText: vi.fn(),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: () => ({ text: drafts.text, attachments: [] }),
  isComposerDraftEmpty: (draft: { text: string }) => draft.text === "",
  updateComposerDraftSettings: drafts.update,
  setComposerDraftText: drafts.setText,
}));

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
  drafts.text = "";
  drafts.update.mockClear();
  drafts.setText.mockClear();
});

it("opens a new task in the selected worktree without using its owner thread", () => {
  expect(preparePlaybookDraft(worktree!, "Start playbook review")).toBe(true);
  expect(drafts.update).toHaveBeenCalledWith("new-task:environment:test:project:test", {
    workspaceSelection: {
      mode: "local",
      branch: "review",
      worktreePath: "/repo/worktrees/review",
      startFromOrigin: false,
    },
  });
  expect(drafts.setText).toHaveBeenCalledWith(
    "new-task:environment:test:project:test",
    "Start playbook review",
  );
});

it("keeps an existing draft and uses the project checkout when selected", () => {
  drafts.text = "Keep this idea";
  expect(preparePlaybookDraft(worktree!, "Start playbook review")).toBe(false);
  expect(drafts.update).not.toHaveBeenCalled();
  expect(drafts.setText).not.toHaveBeenCalled();

  drafts.text = "";
  expect(preparePlaybookDraft(project!, "Create a playbook")).toBe(true);
  expect(drafts.update).toHaveBeenCalledWith("new-task:environment:test:project:test", {
    workspaceSelection: {
      mode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
    },
  });
});

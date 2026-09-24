import type { playbookWorkspaces } from "@t3tools/client-runtime/j5/playbooks";
import {
  createNewTaskDraft,
  setComposerDraftText,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";

export function preparePlaybookDraft(
  workspace: ReturnType<typeof playbookWorkspaces>[number],
  prompt: string,
) {
  const key = createNewTaskDraft({
    environmentId: workspace.environmentId,
    projectId: workspace.projectId,
  });
  updateComposerDraftSettings(key, {
    workspaceSelection: {
      mode: "local",
      branch: workspace.branch,
      worktreePath: workspace.threadId ? workspace.workspaceRoot : null,
      startFromOrigin: false,
    },
  });
  setComposerDraftText(key, prompt);
  return key;
}

import type { playbookWorkspaces } from "@t3tools/client-runtime/j5/playbooks";
import { scopedProjectKey } from "../../lib/scopedEntities";
import {
  getComposerDraftSnapshot,
  isComposerDraftEmpty,
  setComposerDraftText,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";

export function preparePlaybookDraft(
  workspace: ReturnType<typeof playbookWorkspaces>[number],
  prompt: string,
): boolean {
  const key = `new-task:${scopedProjectKey(workspace.environmentId, workspace.projectId)}`;
  if (!isComposerDraftEmpty(getComposerDraftSnapshot(key))) return false;
  updateComposerDraftSettings(key, {
    workspaceSelection: {
      mode: "local",
      branch: workspace.branch,
      worktreePath: workspace.threadId ? workspace.workspaceRoot : null,
      startFromOrigin: false,
    },
  });
  setComposerDraftText(key, prompt);
  return true;
}

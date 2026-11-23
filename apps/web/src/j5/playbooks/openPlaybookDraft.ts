import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { playbookWorkspaces } from "@t3tools/client-runtime/j5/playbooks";
import { composerDraftHasUserContent, useComposerDraftStore } from "../../composerDraftStore";
import type { useNewThreadHandler } from "../../hooks/useHandleNewThread";

export async function openPlaybookDraft(
  workspace: ReturnType<typeof playbookWorkspaces>[number],
  prompt: string,
  openThread: ReturnType<typeof useNewThreadHandler>,
) {
  const opened = await openThread(scopeProjectRef(workspace.environmentId, workspace.projectId), {
    envMode: "local",
    branch: workspace.branch,
    worktreePath: workspace.threadId ? workspace.workspaceRoot : null,
    startFromOrigin: false,
  });
  if (!opened) return "cancelled";
  const store = useComposerDraftStore.getState();
  // Recheck after navigation: the person may have typed while the draft opened.
  if (composerDraftHasUserContent(store.getComposerDraft(opened.draftId))) return "preserved";
  store.setPrompt(opened.draftId, prompt);
  return "opened";
}

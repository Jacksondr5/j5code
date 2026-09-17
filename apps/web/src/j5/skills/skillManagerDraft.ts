import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { SKILL_MANAGER_PERSONA_ID, type ScopedThreadRef } from "@t3tools/contracts";

import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type DraftId,
} from "../../composerDraftStore";
import { selectDraftAgent } from "../agents/agentDraftState";

export function prepareSkillManagerDraft(
  draftId: DraftId,
  threadRef: ScopedThreadRef,
  folder: string,
) {
  const store = useComposerDraftStore.getState();
  // Navigation can race with typing. Never replace work already in the destination draft.
  if (composerDraftHasUserContent(store.getComposerDraft(draftId))) return;
  selectDraftAgent(scopedThreadKey(threadRef), SKILL_MANAGER_PERSONA_ID);
  store.setRuntimeMode(draftId, "approval-required");
  store.setPrompt(
    draftId,
    [
      "Show the available skill groups and help me choose what to install.",
      ...(folder.trim() ? [`Catalog folder: ${JSON.stringify(folder.trim())}`] : []),
    ].join("\n\n"),
  );
}

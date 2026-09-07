import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { hasExplicitComposerModelSelection } from "../../lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "../../logicalProject";
import type { Project } from "../../types";
import { selectDraftSquadron } from "./SquadronDraftState";

/** Change the open draft's home in place, retaining upstream prompt and model selection rules. */
export function retargetSquadronDraft(input: {
  readonly draftId: DraftId;
  readonly squadronId: string;
  readonly project: Project;
  readonly groupingSettings: ProjectGroupingSettings;
}) {
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(input.draftId);
  if (session === null || session.promotedTo != null) return;
  const draft = store.getComposerDraft(input.draftId);
  store.setLogicalProjectDraftThreadId(
    deriveLogicalProjectKeyFromSettings(input.project, input.groupingSettings),
    scopeProjectRef(input.project.environmentId, input.project.id),
    input.draftId,
  );
  if (!hasExplicitComposerModelSelection(draft)) {
    store.applyStickyState(input.draftId);
    if (input.project.defaultModelSelection) {
      store.setModelSelection(input.draftId, input.project.defaultModelSelection, {
        replaceOptions: true,
      });
    }
  }
  selectDraftSquadron(
    scopedThreadKey(scopeThreadRef(input.project.environmentId, session.threadId)),
    input.squadronId,
  );
}

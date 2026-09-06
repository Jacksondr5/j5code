import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import type { Project } from "../../types";
import { freezeDraftSquadronAtFirstSend } from "./SquadronDraftState";
import { retargetSquadronDraft } from "./retargetSquadronDraft";

const local = EnvironmentId.make("retarget-local");
const remote = EnvironmentId.make("retarget-remote");
const groupingSettings = {
  sidebarProjectGroupingMode: "separate" as const,
  sidebarProjectGroupingOverrides: {},
};
const destination: Project = {
  environmentId: remote,
  id: ProjectId.make("destination"),
  title: "Destination",
  workspaceRoot: "/destination",
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "project-default" },
  scripts: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};

beforeEach(() =>
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  }),
);

describe("Squadron selection retargets the existing upstream draft", () => {
  it.each([false, true])("preserves the prompt and explicit model choice: %s", (explicitModel) => {
    const draftId = DraftId.make(`retarget-${explicitModel}`);
    const threadId = ThreadId.make(`reserved-${explicitModel}`);
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(scopeProjectRef(local, ProjectId.make("source")), draftId, {
      threadId,
    });
    store.setPrompt(draftId, "Keep my typed work");
    const chosenModel = { instanceId: ProviderInstanceId.make("codex"), model: "explicit-model" };
    if (explicitModel) store.setModelSelection(draftId, chosenModel, { explicit: true });
    retargetSquadronDraft({
      draftId,
      squadronId: "squadron:destination",
      project: destination,
      groupingSettings,
    });
    expect(store.getDraftSession(draftId)).toMatchObject({
      environmentId: remote,
      projectId: destination.id,
      threadId,
    });
    expect(store.getComposerDraft(draftId)).toMatchObject({
      prompt: "Keep my typed work",
      modelSelectionByProvider: {
        codex: explicitModel ? chosenModel : destination.defaultModelSelection,
      },
    });
    expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toEqual([
      draftId,
    ]);
    expect(freezeDraftSquadronAtFirstSend(scopedThreadKey(scopeThreadRef(remote, threadId)))).toBe(
      "squadron:destination",
    );
  });

  it("keeps two Squadron choices distinct when their folder is identical", () => {
    const draftId = DraftId.make("same-folder");
    const threadId = ThreadId.make("same-folder-reserved");
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(scopeProjectRef(remote, destination.id), draftId, { threadId });
    store.setPrompt(draftId, "Same folder, different home");
    retargetSquadronDraft({
      draftId,
      squadronId: "squadron:first",
      project: destination,
      groupingSettings,
    });
    retargetSquadronDraft({
      draftId,
      squadronId: "squadron:second",
      project: destination,
      groupingSettings,
    });
    expect(freezeDraftSquadronAtFirstSend(scopedThreadKey(scopeThreadRef(remote, threadId)))).toBe(
      "squadron:second",
    );
    expect(store.getComposerDraft(draftId)?.prompt).toBe("Same folder, different home");
  });
});

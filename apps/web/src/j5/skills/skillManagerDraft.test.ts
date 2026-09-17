import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  clearDraftAgent,
  draftAgentPersonaLaunch,
  selectDraftAgent,
} from "../agents/agentDraftState";
import { prepareSkillManagerDraft } from "./skillManagerDraft";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const threadId = ThreadId.make("same-thread-id");
const remoteThread = scopeThreadRef(remote, threadId);
const localThread = scopeThreadRef(local, threadId);
const draftId = DraftId.make("remote-draft-id");

function reset() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  clearDraftAgent(scopedThreadKey(localThread));
  clearDraftAgent(scopedThreadKey(remoteThread));
}

describe("Skill Manager draft", () => {
  beforeEach(() => {
    reset();
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(scopeProjectRef(remote, ProjectId.make("project")), draftId, {
        threadId,
      });
  });
  afterEach(reset);

  it("carries the persona into the remote thread's first send with a short message", () => {
    selectDraftAgent(scopedThreadKey(localThread), "scout");
    prepareSkillManagerDraft(draftId, remoteThread, " /remote/agent skills ");

    expect(draftAgentPersonaLaunch(scopedThreadKey(remoteThread))).toEqual({
      agentPersona: { personaId: "skill-manager" },
    });
    expect(draftAgentPersonaLaunch(scopedThreadKey(localThread))).toEqual({
      agentPersona: { personaId: "scout" },
    });
    expect(useComposerDraftStore.getState().getComposerDraft(remoteThread)).toMatchObject({
      prompt:
        'Show the available skill groups and help me choose what to install.\n\nCatalog folder: "/remote/agent skills"',
      runtimeMode: "approval-required",
    });
  });

  it("preserves text, persona, and permissions entered while the draft was opening", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "Keep my work");
    store.setRuntimeMode(draftId, "auto-accept-edits");
    selectDraftAgent(scopedThreadKey(remoteThread), "builder");
    const before = store.getComposerDraft(draftId);

    prepareSkillManagerDraft(draftId, remoteThread, "");

    expect(store.getComposerDraft(draftId)).toEqual(before);
    expect(draftAgentPersonaLaunch(scopedThreadKey(remoteThread))).toEqual({
      agentPersona: { personaId: "builder" },
    });
  });
});

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerProviderSelection } from "../../components/ChatView.logic";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { deriveEffectiveComposerModelState, useComposerDraftStore } from "../../composerDraftStore";
import { draftAgentPersonaLaunch, finishDraftAgentSend, selectDraftAgent } from "./agentDraftState";
import { composerProviderCandidates, personaRouteToFollow } from "./personaComposerSelection";

describe("composerProviderCandidates", () => {
  const provider = (driver: string, command: string) =>
    deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(driver),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: "2026-10-31T00:00:00.000Z",
        models: [],
        slashCommands: [{ name: command }],
        skills: [],
      } satisfies ServerProvider,
    ])[0]!;
  const entries = [provider("claudeAgent", "advisor"), provider("codex", "review")];
  const codexAgent = {
    personaId: "luna-helper",
    definitionVersion: 1,
    authorityPolicy: "read-only" as const,
    resolvedRoute: "primary" as const,
    resolvedDriver: ProviderDriverKind.make("codex"),
    resolvedModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  };
  const selectedFor = (agent: typeof codexAgent | undefined) =>
    resolveComposerProviderSelection({
      entries,
      candidateInstanceIds: composerProviderCandidates(agent, [
        ProviderInstanceId.make("claudeAgent"),
      ]),
      lockedProvider: null,
      lockedInstanceId: undefined,
    }).selectedProviderEntry?.snapshot;

  it("offers a saved agent's provider commands, not the draft's earlier pick", () => {
    expect(selectedFor(codexAgent)?.slashCommands).toEqual([{ name: "review" }]);
  });

  it("leaves a draft without a saved agent on its own pick", () => {
    expect(selectedFor(undefined)?.slashCommands).toEqual([{ name: "advisor" }]);
  });
});

describe("personaRouteToFollow", () => {
  const assignment = {
    personaId: "scout",
    definitionVersion: 1,
    authorityPolicy: "read-only" as const,
    resolvedRoute: "primary" as const,
    resolvedDriver: ProviderDriverKind.make("codex"),
    resolvedModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  };
  const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5" };

  it("keeps a started persona on its model over a remembered pick, until a person picks", () => {
    const store = useComposerDraftStore.getState();
    const thread = scopeThreadRef(
      EnvironmentId.make("environment:persona-follow"),
      ThreadId.make("thread:persona-follow"),
    );
    const followed = () => personaRouteToFollow(assignment, store.getComposerDraft(thread));

    // A draft is seeded with the person's last model; launching as a persona never ran it.
    store.setStickyModelSelection(claude);
    store.applyStickyState(thread);
    expect(store.getComposerDraft(thread)?.activeProvider).toBe(claude.instanceId);
    expect(followed()).toBe(assignment);

    // The picker's choice is explicit, so the composer sends it and the server checks the switch.
    store.setModelSelection(thread, claude, { explicit: true, replaceOptions: true });
    expect(followed()).toBeUndefined();
  });

  it("starts a launched persona's composer from its model, not the draft's sticky one", () => {
    const store = useComposerDraftStore.getState();
    const thread = scopeThreadRef(
      EnvironmentId.make("environment:persona-launch"),
      ThreadId.make("thread:persona-launch"),
    );
    const draftKey = scopedThreadKey(thread);
    const codex = ProviderInstanceId.make("codex");
    const codexProvider = {
      driver: ProviderDriverKind.make("codex"),
      instanceId: codex,
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      version: null,
      checkedAt: "2026-11-06T00:00:00.000Z",
      models: ["gpt-5", "gpt-6-luna"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: null,
      })),
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;
    const shown = () =>
      deriveEffectiveComposerModelState({
        draft: store.getComposerDraft(thread),
        providers: [codexProvider],
        selectedProvider: ProviderDriverKind.make("codex"),
        selectedInstanceId: codex,
        threadModelSelection: assignment.resolvedModelSelection,
        projectModelSelection: null,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }).selectedModel;

    // The draft remembers gpt-5 on the persona's own provider; the persona launches on gpt-6-luna.
    store.setStickyModelSelection({ instanceId: codex, model: "gpt-5" });
    store.applyStickyState(thread);
    selectDraftAgent(draftKey, "scout");
    expect(shown()).toBe("gpt-5");

    finishDraftAgentSend(draftKey, thread);
    expect(shown()).toBe("gpt-6-luna");
    expect(draftAgentPersonaLaunch(draftKey)).toEqual({});

    // Changing only the effort is a pick on the model the worker runs on.
    store.setProviderModelOptions(
      thread,
      ProviderDriverKind.make("codex"),
      [{ id: "reasoningEffort", value: "low" }],
      { instanceId: codex, model: "gpt-6-luna" },
    );
    expect(personaRouteToFollow(assignment, store.getComposerDraft(thread))).toBeUndefined();
    expect(shown()).toBe("gpt-6-luna");
  });
});

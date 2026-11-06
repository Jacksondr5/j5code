import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerProviderSelection } from "../../components/ChatView.logic";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useComposerDraftStore } from "../../composerDraftStore";
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

    // Choosing a persona drops a pick made before it (AgentDraftPicker).
    store.applyStickyState(thread);
    expect(followed()).toBe(assignment);
  });
});

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerProviderSelection } from "../../components/ChatView.logic";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  composerModelSelectionForThread,
  composerProviderCandidates,
} from "./personaComposerSelection";

describe("composerModelSelectionForThread", () => {
  const codexHigh = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const draftPick = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5" };

  it("sends the persona's launch route regardless of what the draft remembered", () => {
    expect(
      composerModelSelectionForThread(
        {
          personaId: "navigator",
          definitionVersion: 3,
          authorityPolicy: "read-only",
          resolvedRoute: "primary",
          resolvedDriver: ProviderDriverKind.make("codex"),
          resolvedModelSelection: codexHigh,
        },
        draftPick,
      ),
    ).toEqual(codexHigh);
  });

  it("leaves ordinary threads on the composer's pick", () => {
    expect(composerModelSelectionForThread(undefined, draftPick)).toBe(draftPick);
  });
});

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

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerModelSelectionForThread } from "./personaComposerSelection";

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
          personaId: "crew-captain",
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

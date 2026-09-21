import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { CUSTOM_AGENT, addSeat } from "./crewProposalDraft";
import {
  applyCrewSeatDraft,
  chooseCrewSeatPersona,
  chooseCrewHarness,
  crewModelSelection,
  crewReasoningDescriptor,
  crewSeatDraft,
  resolvedCrewSeatDraft,
  setCrewReasoning,
} from "./crewSeatRuntime";

const runtime: CrewProposalSeatRuntime = {
  seat: "reviewer",
  provider: "OpenAI",
  harness: "Codex",
  model: "GPT-6-Astra",
  reasoning: "High",
  access: "Full access",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex-work"),
    model: "gpt-6-astra",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ],
  },
  runtimeMode: "full-access",
};
const seat = {
  seat: "reviewer",
  agentId: null,
  reason: "Review the patch",
  instructions: "Focus on tests",
};
const model: ServerProviderModel = {
  slug: "other-model",
  name: "Other model",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          { id: "low", label: "Low", isDefault: true },
          { id: "medium", label: "Medium" },
        ],
      },
    ],
  },
};

describe("crew member edits", () => {
  it("initializes edits from the resolved runtime and preserves unrelated settings", () => {
    const initialized = resolvedCrewSeatDraft(crewSeatDraft(seat), runtime);
    const edited = applyCrewSeatDraft(seat, {
      ...initialized,
      runtimeMode: "approval-required",
      instructions: "Review authentication",
    });
    expect(edited).toEqual({
      ...seat,
      instructions: "Review authentication",
      modelSelection: runtime.modelSelection,
      runtimeMode: "approval-required",
    });
    const refreshed = resolvedCrewSeatDraft(crewSeatDraft(edited), runtime);
    expect(refreshed.runtimeMode).toBe("approval-required");
  });

  it("keeps the saved persona and unrelated settings when editing its runtime", () => {
    const saved = { ...seat, agentId: "sentry" };
    const draft = resolvedCrewSeatDraft(crewSeatDraft(saved), runtime);
    expect(draft.runtimeMode).toBeUndefined();
    expect(applyCrewSeatDraft(saved, draft)).not.toHaveProperty("runtimeMode");
    expect(applyCrewSeatDraft(saved, { ...draft, runtimeMode: "approval-required" })).toEqual({
      ...saved,
      modelSelection: runtime.modelSelection,
      runtimeMode: "approval-required",
    });
  });

  it("clears custom overrides when selecting a saved persona or returning to custom", () => {
    const initialized = resolvedCrewSeatDraft(crewSeatDraft(seat), runtime);
    const persona = chooseCrewSeatPersona(initialized, "sentry");
    expect(applyCrewSeatDraft(seat, persona)).toEqual({ ...seat, agentId: "sentry" });
    expect(chooseCrewSeatPersona(persona, CUSTOM_AGENT)).toEqual(crewSeatDraft(seat));
  });

  it("resets model options to the newly chosen model's advertised defaults", () => {
    const selected = crewModelSelection(
      { instanceId: ProviderInstanceId.make("claude-work") },
      model,
    );
    expect(selected).toEqual({
      instanceId: "claude-work",
      model: "other-model",
      options: [{ id: "effort", value: "low" }],
    });
    const noOptions = crewModelSelection(
      { instanceId: ProviderInstanceId.make("codex-work") },
      { ...model, capabilities: null },
    );
    expect(noOptions).not.toHaveProperty("options");
  });

  it.each(["auto", "auto-accept-edits"] as const)(
    "switches unsupported ACP %s access to explicit Approval required",
    (runtimeMode) => {
      const draft = { ...crewSeatDraft(seat), runtimeMode };
      const acp = {
        instanceId: ProviderInstanceId.make("acp-work"),
        driver: ProviderDriverKind.make("acpRegistry"),
      };
      const next = chooseCrewHarness(draft, acp, model);
      expect(next.runtimeMode).toBe("approval-required");
      expect(next.modelSelection).toEqual(crewModelSelection(acp, model));
      expect(next.instructions).toBe(seat.instructions);
      expect(
        chooseCrewHarness(draft, { ...acp, driver: ProviderDriverKind.make("codex") }, model)
          .runtimeMode,
      ).toBe(runtimeMode);
    },
  );

  it("retains supported explicit access when switching to ACP", () => {
    const acp = {
      instanceId: ProviderInstanceId.make("acp-work"),
      driver: ProviderDriverKind.make("acpRegistry"),
    };
    expect(
      chooseCrewHarness({ ...crewSeatDraft(seat), runtimeMode: "full-access" }, acp, model)
        .runtimeMode,
    ).toBe("full-access");
    expect(
      chooseCrewHarness({ ...crewSeatDraft(seat), runtimeMode: "approval-required" }, acp, model)
        .runtimeMode,
    ).toBe("approval-required");
  });

  it("changes reasoning without discarding other model options", () => {
    const descriptor = {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: [{ id: "medium", label: "Medium" }],
    };
    expect(setCrewReasoning(runtime.modelSelection, descriptor, "medium").options).toEqual([
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "medium" },
    ]);
    expect(crewReasoningDescriptor(model)?.id).toBe("effort");
    expect(
      crewReasoningDescriptor({
        ...model,
        capabilities: {
          optionDescriptors: [
            { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
          ],
        },
      })?.id,
    ).toBe("thinking");
  });

  it("manual additions preserve the chosen runtime for custom and saved-persona members", () => {
    const draft = {
      ...resolvedCrewSeatDraft(crewSeatDraft(seat), runtime),
      seat: "Second Reviewer",
    };
    const added = addSeat([seat], draft);
    expect(added.error).toBeNull();
    expect(added.seats[1]).toEqual({
      ...seat,
      seat: "second-reviewer",
      reason: "Added by the user",
      modelSelection: runtime.modelSelection,
      runtimeMode: "full-access",
    });
    const saved = addSeat([seat], { ...draft, agentId: "sentry" });
    expect(saved.seats[1]?.modelSelection).toEqual(runtime.modelSelection);
    expect(saved.seats[1]?.runtimeMode).toBe("full-access");
  });
});

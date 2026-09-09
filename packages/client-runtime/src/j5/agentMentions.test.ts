import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2AgentPersonaCatalog,
} from "@t3tools/contracts";
import { agentPersonaMentionItems, applyAgentMentionSelection } from "./agentMentions.ts";

const persona = (
  personaId: string,
  displayName: string,
  reason?: "disabled" | "routes-unavailable",
): OrchestrationV2AgentPersonaCatalog["personas"][number] => ({
  personaId,
  displayName,
  description: "Finds evidence",
  definitionVersion: 1,
  acceptedInput: "prompt",
  outputArtifact: "Brief",
  defaultAuthorityPolicy: "read-only",
  allowedAuthorityPolicies: ["read-only"],
  availability: reason
    ? { status: "unavailable", reason }
    : {
        status: "available",
        resolvedRoute: "primary",
        resolvedDriver: ProviderDriverKind.make("claudeAgent"),
        resolvedModelSelection: {
          instanceId: ProviderInstanceId.make("remote-claude"),
          model: "claude-opus-5",
        },
      },
});
const catalog = {
  personas: [
    persona("team-researcher", "Researcher"),
    persona("other-researcher", "Researcher"),
    persona("disabled", "Disabled", "disabled"),
    persona("offline", "Offline", "routes-unavailable"),
  ],
};

describe("agent picker", () => {
  it("offers only launchable agents without filtering out cross-provider routes", () => {
    expect(agentPersonaMentionItems(catalog, "").map((item) => item.personaId)).toEqual([
      "team-researcher",
      "other-researcher",
    ]);
  });
  it("searches names, stable IDs and descriptions and distinguishes duplicate names", () => {
    expect(agentPersonaMentionItems(catalog, "TEAM-").map((item) => item.personaId)).toEqual([
      "team-researcher",
    ]);
    expect(agentPersonaMentionItems(catalog, "evidence")).toHaveLength(2);
    expect(
      new Set(agentPersonaMentionItems(catalog, "researcher").map((item) => item.id)).size,
    ).toBe(2);
  });
  it("does not reuse another environment's results before a catalog loads", () => {
    expect(agentPersonaMentionItems(null, "")).toEqual([]);
  });
});

describe("agent mention selection", () => {
  it("replaces exactly the typed trigger with the stable mention and reports the outcome", () => {
    const calls: Array<unknown[]> = [];
    const text = "fix @agent:sc please";
    const trigger = { rangeStart: 4, rangeEnd: 13 };
    const applied = applyAgentMentionSelection({ personaId: "scout" }, trigger, text, (...args) => {
      calls.push(args);
      return true;
    });
    expect(applied).toBe(true);
    expect(calls).toEqual([[4, 13, "@agent:scout ", { expectedText: "@agent:sc" }]]);
    expect(applyAgentMentionSelection({ personaId: "scout" }, trigger, text, () => false)).toBe(
      false,
    );
  });
});

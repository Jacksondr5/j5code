import {
  BUILT_IN_AGENT_PERSONA_IDS,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2AgentPersonaCatalog,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentAgentPersonaAssignment, presentAgentPersonaCatalog } from "./agentPersonas.ts";

const catalog: OrchestrationV2AgentPersonaCatalog = {
  personas: BUILT_IN_AGENT_PERSONA_IDS.map((personaId, index) => ({
    personaId,
    definitionVersion: 1,
    displayName: personaId,
    description: `${personaId} description`,
    acceptedInput: `${personaId} input`,
    outputArtifact: "ContextBrief",
    defaultAuthorityPolicy: "read-only",
    allowedAuthorityPolicies: ["read-only"],
    availability:
      index === 0
        ? {
            status: "available",
            resolvedRoute: "fallback",
            resolvedDriver: ProviderDriverKind.make("codex"),
            resolvedModelSelection: {
              instanceId: ProviderInstanceId.make("remote-codex"),
              model: "server-selected-model",
            },
          }
        : { status: "unavailable", reason: "routes-unavailable" },
  })),
};

describe("agent persona catalog presentation", () => {
  it("presents a durable assignment with its immutable provider route", () => {
    expect(
      presentAgentPersonaAssignment({
        personaId: "critic",
        definitionVersion: 1,
        authorityPolicy: "critic-fix",
        resolvedRoute: "fallback",
        resolvedDriver: ProviderDriverKind.make("codex"),
        resolvedModelSelection: {
          instanceId: ProviderInstanceId.make("remote-codex"),
          model: "gpt-5.6-terra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      }),
    ).toEqual({
      personaLabel: "Critic · Fix",
      routeLabel: "Codex · gpt-5.6-terra · high",
    });
  });

  it("preserves all eleven server-provided personas for every client", () => {
    expect(presentAgentPersonaCatalog(catalog).map(({ personaId }) => personaId)).toEqual([
      ...BUILT_IN_AGENT_PERSONA_IDS,
    ]);
  });

  it("presents the server-resolved remote route without recalculating it", () => {
    expect(presentAgentPersonaCatalog(catalog)[0]).toMatchObject({
      availability: "available",
      availabilityLabel: "Available",
      route: "Codex · server-selected-model · fallback",
    });
  });

  it("presents unavailable personas as clearly blocked", () => {
    expect(presentAgentPersonaCatalog(catalog)[1]).toMatchObject({
      availability: "blocked",
      availabilityLabel: "Blocked",
      route: "Primary and fallback models unavailable",
    });
  });

  it("distinguishes an unenforceable authority boundary from missing models", () => {
    const authorityBlocked = {
      personas: [
        {
          ...catalog.personas[1]!,
          availability: {
            status: "unavailable" as const,
            reason: "authority-not-enforceable" as const,
          },
        },
      ],
    };

    expect(presentAgentPersonaCatalog(authorityBlocked)[0]?.route).toBe(
      "Required authority is not yet enforceable",
    );
  });
});

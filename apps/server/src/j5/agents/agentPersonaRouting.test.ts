import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  buildBuiltInAgentPersonaCatalog,
  resolveBuiltInAgentPersonaRoute,
} from "./agentPersonaRouting.ts";

function model(
  slug: string,
  optionId: "reasoningEffort" | "effort",
  efforts: ReadonlyArray<string> = ["medium", "high"],
): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: optionId,
          label: "Reasoning",
          type: "select",
          options: efforts.map((effort) => ({ id: effort, label: effort })),
        },
      ],
    },
  };
}

function provider(input: {
  readonly instanceId: string;
  readonly driver: "codex" | "claudeAgent";
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly status?: ServerProvider["status"];
  readonly authStatus?: ServerProvider["auth"]["status"];
  readonly availability?: ServerProvider["availability"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: "2026-09-02T00:00:00.000Z",
    availability: input.availability ?? "available",
    models: input.models,
    slashCommands: [],
    skills: [],
  };
}

describe("agent persona routing", () => {
  it("selects the primary provider, exact model, and provider-specific effort option", () => {
    const resolution = resolveBuiltInAgentPersonaRoute({
      personaId: "scout",
      providers: [
        provider({
          instanceId: "codex",
          driver: "codex",
          models: [model("gpt-5.6-terra", "reasoningEffort")],
        }),
      ],
    });

    assert.deepEqual(resolution, {
      status: "available",
      personaId: "scout",
      definitionVersion: 1,
      route: "primary",
      driver: "codex",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-terra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      rejectedTargets: [],
    });
  });

  it("uses fallback only after recording why the primary is ineligible", () => {
    const resolution = resolveBuiltInAgentPersonaRoute({
      personaId: "skeptic",
      providers: [
        provider({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          models: [model("claude-opus-5", "effort")],
        }),
        provider({
          instanceId: "codex",
          driver: "codex",
          models: [model("gpt-5.6-terra", "reasoningEffort")],
        }),
      ],
    });

    assert.equal(resolution.status, "available");
    if (resolution.status === "unavailable") return;
    assert.equal(resolution.route, "fallback");
    assert.equal(resolution.modelSelection.instanceId, "codex");
    assert.deepEqual(resolution.rejectedTargets, [
      {
        route: "primary",
        target: {
          driver: "claudeAgent",
          model: "claude-opus-5",
          reasoningEffort: "high",
        },
        failures: [
          {
            code: "provider-disabled",
            instanceId: ProviderInstanceId.make("claudeAgent"),
          },
        ],
      },
    ]);
  });

  it("prefers the default instance before configured custom instances", () => {
    const terra = model("gpt-5.6-terra", "reasoningEffort");
    const resolution = resolveBuiltInAgentPersonaRoute({
      personaId: "scout",
      providers: [
        provider({ instanceId: "codex_work", driver: "codex", models: [terra] }),
        provider({ instanceId: "codex", driver: "codex", models: [terra] }),
      ],
    });

    assert.equal(resolution.status, "available");
    if (resolution.status === "unavailable") return;
    assert.equal(resolution.modelSelection.instanceId, "codex");
  });

  it("fails closed when neither target advertises the exact model and effort", () => {
    const resolution = resolveBuiltInAgentPersonaRoute({
      personaId: "skeptic",
      providers: [
        provider({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          models: [model("claude-sonnet-5", "effort")],
        }),
        provider({
          instanceId: "codex",
          driver: "codex",
          models: [model("gpt-5.6-terra", "reasoningEffort", ["medium"])],
        }),
      ],
    });

    assert.equal(resolution.status, "unavailable");
    if (resolution.status === "available") return;
    assert.deepEqual(
      resolution.attempts.map(({ failures }) => failures.map(({ code }) => code)),
      [["model-not-advertised"], ["reasoning-effort-not-advertised"]],
    );
  });

  it("builds the ordered presentation catalog with environment-specific availability", () => {
    const catalog = buildBuiltInAgentPersonaCatalog([
      provider({
        instanceId: "codex",
        driver: "codex",
        models: [model("gpt-5.6-terra", "reasoningEffort")],
      }),
    ]);

    assert.equal(catalog.personas.length, 11);
    assert.equal(catalog.personas[0]?.personaId, "scout");
    assert.equal(catalog.personas[0]?.acceptedInput, "Evidence request or prompt");
    assert.equal(catalog.personas[0]?.outputArtifact, "ContextBrief");
    assert.deepEqual(catalog.personas[0]?.availability, {
      status: "available",
      resolvedRoute: "primary",
      resolvedDriver: ProviderDriverKind.make("codex"),
      resolvedModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-terra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    assert.equal(
      catalog.personas.find(({ personaId }) => personaId === "builder")?.availability.status,
      "unavailable",
    );
  });
});

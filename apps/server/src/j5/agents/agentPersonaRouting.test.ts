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
import { providerCanEnforceAgentPersonaAuthority } from "./agentPersonaProviderPolicy.ts";
import { listBuiltInAgentPersonas, type AgentModelTarget } from "./agentPersonas.ts";

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

function providerForTarget(
  target: AgentModelTarget,
  overrides?: { readonly enabled?: boolean },
): ServerProvider {
  return provider({
    instanceId: target.driver,
    driver: target.driver,
    models: [
      model(target.model, target.driver === "codex" ? "reasoningEffort" : "effort", [
        target.reasoningEffort,
      ]),
    ],
    ...(overrides?.enabled === undefined ? {} : { enabled: overrides.enabled }),
  });
}

describe("agent persona routing", () => {
  it("uses every enforceable persona's declared primary route when it is available", () => {
    for (const definition of listBuiltInAgentPersonas()) {
      const [primary, fallback] = definition.modelRoute;
      const resolution = resolveBuiltInAgentPersonaRoute({
        personaId: definition.id,
        providers: [providerForTarget(fallback), providerForTarget(primary)],
      });

      const enforceable = providerCanEnforceAgentPersonaAuthority(
        primary.driver,
        definition.authority.defaultPolicy,
      );
      assert.equal(resolution.status, enforceable ? "available" : "unavailable", definition.id);
      if (resolution.status === "unavailable") continue;
      assert.equal(resolution.route, "primary", definition.id);
      assert.equal(resolution.driver, primary.driver, definition.id);
      assert.equal(resolution.modelSelection.model, primary.model, definition.id);
    }
  });

  it("uses only an enforceable declared fallback after its primary is unavailable", () => {
    for (const definition of listBuiltInAgentPersonas()) {
      const [primary, fallback] = definition.modelRoute;
      const resolution = resolveBuiltInAgentPersonaRoute({
        personaId: definition.id,
        providers: [providerForTarget(primary, { enabled: false }), providerForTarget(fallback)],
      });

      const enforceable = providerCanEnforceAgentPersonaAuthority(
        fallback.driver,
        definition.authority.defaultPolicy,
      );
      assert.equal(resolution.status, enforceable ? "available" : "unavailable", definition.id);
      if (resolution.status === "unavailable") continue;
      assert.equal(resolution.route, "fallback", definition.id);
      assert.equal(resolution.driver, fallback.driver, definition.id);
      assert.equal(resolution.modelSelection.model, fallback.model, definition.id);
      assert.deepEqual(
        resolution.rejectedTargets.map(({ target }) => target),
        [primary],
      );
    }
  });

  it("skips Claude and uses the Codex fallback for Critic Fix Mode", () => {
    const definition = listBuiltInAgentPersonas().find(({ id }) => id === "critic")!;
    const [primary, fallback] = definition.modelRoute;
    const resolution = resolveBuiltInAgentPersonaRoute({
      personaId: "critic",
      authorityPolicy: "critic-fix",
      providers: [providerForTarget(primary), providerForTarget(fallback)],
    });

    assert.equal(resolution.status, "available");
    if (resolution.status === "unavailable") return;
    assert.equal(resolution.route, "fallback");
    assert.equal(resolution.driver, "codex");
    assert.deepEqual(
      resolution.rejectedTargets[0]?.failures.map(({ code }) => code),
      ["authority-not-enforceable"],
    );
  });

  it("blocks Builder fallback, Investigator, and Publisher when authority cannot be enforced", () => {
    for (const personaId of ["builder", "investigator", "publisher"] as const) {
      const definition = listBuiltInAgentPersonas().find(({ id }) => id === personaId)!;
      const [primary, fallback] = definition.modelRoute;
      const providers =
        personaId === "builder"
          ? [providerForTarget(primary, { enabled: false }), providerForTarget(fallback)]
          : [providerForTarget(primary), providerForTarget(fallback)];
      const resolution = resolveBuiltInAgentPersonaRoute({ personaId, providers });

      assert.equal(resolution.status, "unavailable", personaId);
      if (resolution.status === "available") continue;
      assert.isTrue(
        resolution.attempts.some(({ failures }) =>
          failures.some(({ code }) => code === "authority-not-enforceable"),
        ),
        personaId,
      );
    }
  });

  it("blocks every persona when both declared routes are unavailable", () => {
    for (const definition of listBuiltInAgentPersonas()) {
      const resolution = resolveBuiltInAgentPersonaRoute({
        personaId: definition.id,
        providers: [],
      });

      assert.equal(resolution.status, "unavailable", definition.id);
      if (resolution.status === "available") continue;
      assert.deepEqual(
        resolution.attempts.map(({ target }) => target),
        [...definition.modelRoute],
      );
      assert.deepEqual(
        resolution.attempts.map(({ failures }) => failures.map(({ code }) => code)),
        definition.modelRoute.map((target) => [
          providerCanEnforceAgentPersonaAuthority(target.driver, definition.authority.defaultPolicy)
            ? "provider-not-configured"
            : "authority-not-enforceable",
        ]),
      );
    }
  });

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
    assert.equal(catalog.personas[0]?.definitionVersion, 1);
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
    assert.deepEqual(
      catalog.personas.find(({ personaId }) => personaId === "publisher")?.availability,
      { status: "unavailable", reason: "authority-not-enforceable" },
    );
  });
});

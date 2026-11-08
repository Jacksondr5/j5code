import { claudeUsageResponseToLimits } from "../../provider/claudeUsageLimits.ts";
import * as Schema from "effect/Schema";
import { stringify as yaml } from "yaml";
import {
  buildAgentPersonaAssignment,
  validateAgentPersonaAssignment,
} from "./agentPersonaAssignment.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  AgentPersonaDefinitionView,
  AgentPersonaModelTarget,
  J5AgentPersonaRpcSchemas,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  agentPersonaModelSelection,
  agentPersonaDefinitionView,
  agentPersonaTargetUnavailableReason,
  buildAgentPersonaCatalog,
  resolveAgentPersonaRoute,
} from "./agentPersonaRouting.ts";
import { providerCanEnforceAgentPersonaAuthority } from "./agentPersonaProviderPolicy.ts";
import {
  decodeAgentPersonaDefinition,
  listBuiltInAgentPersonas,
  type AgentModelTarget,
} from "./agentPersonas.ts";

const decodePersonaRead = Schema.decodeSync(J5AgentPersonaRpcSchemas.readAgentPersona.output);
const decodeDefinitionView = Schema.decodeSync(AgentPersonaDefinitionView);

function model(
  slug: string,
  optionId: string,
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
  readonly driver: string;
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
  it("selects the first eligible instance from an ordered list and reports every entry", () => {
    const definition = listBuiltInAgentPersonas()[0]!;
    const target = (instance: string, slug = "ordered-model") => ({
      instanceId: ProviderInstanceId.make(instance),
      model: slug,
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    const signedOut = provider({
      instanceId: "signed-out",
      driver: "codex",
      authStatus: "unauthenticated",
      models: [model("ordered-model", "reasoningEffort")],
    });
    const wrongModel = provider({ instanceId: "wrong-model", driver: "codex", models: [] });
    const ready = provider({
      instanceId: "ready",
      driver: "codex",
      models: [model("ordered-model", "reasoningEffort")],
    });
    const resolution = resolveAgentPersonaRoute({
      now: 0,
      personaId: definition.id,
      definition: {
        ...definition,
        modelRoute: [
          target("signed-out"),
          target("wrong-model"),
          target("ready"),
          target("missing"),
        ],
      },
      providers: [ready, wrongModel, signedOut],
    });
    assert.equal(resolution.status, "available");
    if (resolution.status !== "available") return;
    assert.equal(resolution.entryIndex, 2);
    assert.equal(resolution.modelSelection.instanceId, "ready");
    assert.deepEqual(
      resolution.entries!.map((entry) => entry.failures.map(({ code }) => code)),
      [["provider-unauthenticated"], ["model-not-advertised"], [], ["provider-not-configured"]],
    );
  });

  it("skips entries an agent may not pick and keeps each entry's own reason", () => {
    const definition = listBuiltInAgentPersonas()[0]!;
    const target = (instance: string) => ({
      instanceId: ProviderInstanceId.make(instance),
      model: "ordered-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    const ready = (instanceId: string) =>
      provider({
        instanceId,
        driver: "codex",
        models: [model("ordered-model", "reasoningEffort")],
      });
    const signedOut = provider({
      instanceId: "signed-out",
      driver: "codex",
      authStatus: "unauthenticated",
      models: [model("ordered-model", "reasoningEffort")],
    });
    const route = (eligible: (instanceId: string) => boolean) =>
      resolveAgentPersonaRoute({
        now: 0,
        personaId: definition.id,
        definition: {
          ...definition,
          modelRoute: [target("unchecked"), target("signed-out"), target("checked")],
        },
        providers: [ready("unchecked"), signedOut, ready("checked")],
        eligible: (selection) => eligible(selection.instanceId),
      });
    const codes = (
      entries: ReadonlyArray<{ readonly failures: ReadonlyArray<{ code: string }> }>,
    ) => entries.map((entry) => entry.failures.map(({ code }) => code));

    const picked = route((instanceId) => instanceId !== "unchecked");
    assert.equal(picked.status, "available");
    if (picked.status !== "available") return;
    assert.equal(picked.modelSelection.instanceId, "checked");
    assert.deepEqual(codes(picked.entries!), [
      ["model-not-eligible"],
      ["provider-unauthenticated"],
      [],
    ]);

    const none = route(() => false);
    assert.equal(none.status, "unavailable");
    if (none.status !== "unavailable") return;
    assert.deepEqual(codes(none.attempts), [
      ["model-not-eligible"],
      ["provider-unauthenticated"],
      ["model-not-eligible"],
    ]);
  });
  it("moves an author's model to the end, ignoring a provider prefix but not the version", () => {
    const definition = listBuiltInAgentPersonas()[0]!;
    const entry = (instanceId: string, slug: string) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      model: slug,
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    const route = (avoid: ReadonlyArray<string>) =>
      resolveAgentPersonaRoute({
        now: 0,
        personaId: definition.id,
        definition: {
          ...definition,
          modelRoute: [
            entry("opencode", "anthropic/claude-opus-5-5"),
            entry("codex", "gpt-6.1-sol"),
            entry("codex", "gpt-6-sol"),
          ],
        },
        providers: [
          provider({
            instanceId: "opencode",
            driver: "codex",
            models: [model("anthropic/claude-opus-5-5", "reasoningEffort")],
          }),
          provider({
            instanceId: "codex",
            driver: "codex",
            models: [
              model("gpt-6.1-sol", "reasoningEffort"),
              model("gpt-6-sol", "reasoningEffort"),
            ],
          }),
        ],
        avoidModels: new Set(avoid),
      });
    const picked = (avoid: ReadonlyArray<string>) => {
      const resolution = route(avoid);
      return resolution.status === "available" ? resolution.modelSelection.model : null;
    };
    assert.equal(picked(["claude-opus-5-5"]), "gpt-6.1-sol");
    assert.equal(picked(["claude-opus-5-5", "gpt-6.1-sol"]), "gpt-6-sol");
    // Only an author's model left: it still runs, in the persona's own order.
    assert.equal(
      picked(["claude-opus-5-5", "gpt-6.1-sol", "gpt-6-sol"]),
      "anthropic/claude-opus-5-5",
    );
  });

  it("uses every enforceable persona's declared primary route when it is available", () => {
    for (const definition of listBuiltInAgentPersonas()) {
      const [primary, fallback] = definition.modelRoute;
      const resolution = resolveAgentPersonaRoute({
        now: 0,
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
      const resolution = resolveAgentPersonaRoute({
        now: 0,
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
    const resolution = resolveAgentPersonaRoute({
      now: 0,
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
      const resolution = resolveAgentPersonaRoute({ now: 0, personaId, providers });

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

  it("reports each rejected route with its target and failure codes in the catalog", () => {
    const scout = listBuiltInAgentPersonas().find(({ id }) => id === "scout")!;
    const [primary, fallback] = scout.modelRoute;
    const catalog = buildAgentPersonaCatalog(
      [
        providerForTarget(primary, { enabled: false }),
        providerForTarget({ ...fallback, model: "some-other-model" }),
      ],
      [scout],
      0,
    );
    const availability = catalog.personas[0]!.availability;
    assert.equal(availability.status, "unavailable");
    if (availability.status === "available") return;
    assert.isUndefined(availability.attempts);
    assert.deepEqual(
      catalog.personas[0]!.modelEntries?.map(({ failures }) => failures),
      [["provider-disabled"], ["model-not-advertised"]],
    );
  });

  it("blocks every persona when both declared routes are unavailable", () => {
    for (const definition of listBuiltInAgentPersonas()) {
      const resolution = resolveAgentPersonaRoute({
        now: 0,
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
        definition.modelRoute.map((target) =>
          providerCanEnforceAgentPersonaAuthority(target.driver, definition.authority.defaultPolicy)
            ? ["provider-not-configured"]
            : ["authority-not-enforceable", "provider-not-configured"],
        ),
      );
    }
  });

  it("selects the primary provider, exact model, and provider-specific effort option", () => {
    const resolution = resolveAgentPersonaRoute({
      now: 0,
      personaId: "scout",
      providers: [
        provider({
          instanceId: "codex",
          driver: ProviderDriverKind.make("codex"),
          models: [model("gpt-5.6-terra", "reasoningEffort")],
        }),
      ],
    });

    assert.deepInclude(resolution, {
      status: "available",
      personaId: "scout",
      definitionVersion: 1,
      route: "primary",
      driver: ProviderDriverKind.make("codex"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-terra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      rejectedTargets: [],
    });
  });

  it("routes any signed-in provider and reports when it cannot enforce the persona's authority", () => {
    const [scout] = listBuiltInAgentPersonas();
    const cursorRoute = {
      driver: ProviderDriverKind.make("cursor"),
      model: "gpt-5.5",
      reasoningEffort: "high",
    };
    const resolution = resolveAgentPersonaRoute({
      now: 0,
      personaId: scout!.id,
      definition: { ...scout!, modelRoute: [cursorRoute, cursorRoute] },
      providers: [
        provider({ instanceId: "cursor", driver: "cursor", models: [model("gpt-5.5", "effort")] }),
      ],
    });

    assert.equal(resolution.status, "unavailable");
    if (resolution.status !== "unavailable") return;
    assert.deepEqual(
      resolution.attempts.map(({ target, failures }) => [
        String("driver" in target ? target.driver : target.instanceId),
        failures,
      ]),
      [
        [
          "cursor",
          [{ code: "authority-not-enforceable", instanceId: ProviderInstanceId.make("cursor") }],
        ],
        [
          "cursor",
          [{ code: "authority-not-enforceable", instanceId: ProviderInstanceId.make("cursor") }],
        ],
      ],
    );
  });

  it("routes a full-access persona to a Cursor route", () => {
    const [scout] = listBuiltInAgentPersonas();
    const cursorRoute = {
      driver: ProviderDriverKind.make("cursor"),
      model: "gpt-5.5",
      reasoningEffort: "high",
    };
    const resolution = resolveAgentPersonaRoute({
      now: 0,
      personaId: scout!.id,
      definition: {
        ...scout!,
        authority: { defaultPolicy: "full-access", allowedPolicies: ["full-access"] },
        modelRoute: [cursorRoute, cursorRoute],
      },
      providers: [
        provider({ instanceId: "cursor", driver: "cursor", models: [model("gpt-5.5", "effort")] }),
      ],
    });

    assert.equal(resolution.status, "available");
    if (resolution.status !== "available") return;
    assert.equal(String(resolution.driver), "cursor");
  });

  it("names a missing provider alongside an unenforceable one", () => {
    const [scout] = listBuiltInAgentPersonas();
    const typo = {
      driver: ProviderDriverKind.make("claude"),
      model: "claude-opus-5",
      reasoningEffort: "high",
    };
    const resolution = resolveAgentPersonaRoute({
      now: 0,
      personaId: scout!.id,
      definition: { ...scout!, modelRoute: [typo, typo] },
      providers: [],
    });

    assert.equal(resolution.status, "unavailable");
    if (resolution.status !== "unavailable") return;
    assert.deepEqual(
      resolution.attempts.map(({ failures }) => failures),
      [
        [{ code: "authority-not-enforceable" }, { code: "provider-not-configured" }],
        [{ code: "authority-not-enforceable" }, { code: "provider-not-configured" }],
      ],
    );
  });

  it("launches with the model's own reasoning option id", () => {
    const selection = (driver: string, optionId: string) =>
      agentPersonaModelSelection(
        provider({ instanceId: driver, driver, models: [model("m", optionId)] }),
        { driver: ProviderDriverKind.make(driver), model: "m", reasoningEffort: "high" },
      ).options;

    assert.deepEqual(selection("opencode", "variant"), [{ id: "variant", value: "high" }]);
    assert.deepEqual(selection("cursor", "reasoning"), [{ id: "reasoning", value: "high" }]);
    assert.deepEqual(selection("pi", "thinking"), [{ id: "thinking", value: "high" }]);
  });

  it("uses fallback only after recording why the primary is ineligible", () => {
    const resolution = resolveAgentPersonaRoute({
      now: 0,
      personaId: "skeptic",
      providers: [
        provider({
          instanceId: "claudeAgent",
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
          models: [model("claude-opus-5", "effort")],
        }),
        provider({
          instanceId: "codex",
          driver: ProviderDriverKind.make("codex"),
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
        entryIndex: 0,
        target: {
          driver: ProviderDriverKind.make("claudeAgent"),
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
    const resolution = resolveAgentPersonaRoute({
      now: 0,
      personaId: "scout",
      providers: [
        provider({
          instanceId: "codex_work",
          driver: ProviderDriverKind.make("codex"),
          models: [terra],
        }),
        provider({
          instanceId: "codex",
          driver: ProviderDriverKind.make("codex"),
          models: [terra],
        }),
      ],
    });

    assert.equal(resolution.status, "available");
    if (resolution.status === "unavailable") return;
    assert.equal(resolution.modelSelection.instanceId, "codex");
  });

  it("fails closed when neither target advertises the exact model and effort", () => {
    const resolution = resolveAgentPersonaRoute({
      now: 0,
      personaId: "skeptic",
      providers: [
        provider({
          instanceId: "claudeAgent",
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [model("claude-sonnet-5", "effort")],
        }),
        provider({
          instanceId: "codex",
          driver: ProviderDriverKind.make("codex"),
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
    const catalog = buildAgentPersonaCatalog(
      [
        provider({
          instanceId: "codex",
          driver: ProviderDriverKind.make("codex"),
          models: [model("gpt-5.6-terra", "reasoningEffort")],
        }),
      ],
      listBuiltInAgentPersonas(),
      0,
    );

    assert.equal(catalog.personas.length, 11);
    assert.equal(catalog.personas[0]?.personaId, "scout");
    assert.equal(catalog.personas[0]?.definitionVersion, 1);
    assert.equal(catalog.personas[0]?.acceptedInput, "Evidence request or prompt");
    assert.notProperty(catalog.personas[0]!, "outputArtifact");
    assert.deepEqual(catalog.personas[0]?.availability, {
      status: "available",
      resolvedRoute: "primary",
      resolvedEntryIndex: 0,
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
    const publisher = catalog.personas.find(({ personaId }) => personaId === "publisher")!;
    assert.equal(publisher.availability.status, "unavailable");
    if (publisher.availability.status === "unavailable") {
      assert.equal(publisher.availability.reason, "authority-not-enforceable");
      assert.deepEqual(
        publisher.modelEntries?.map(({ failures }) => failures),
        [["authority-not-enforceable"], ["authority-not-enforceable", "provider-not-configured"]],
      );
    }
  });
});

it("presents imported definitions without transmitting their instruction bodies", () => {
  const definition = {
    ...listBuiltInAgentPersonas()[0]!,
    id: "team-researcher",
    displayName: "Team Researcher",
  };
  const catalog = buildAgentPersonaCatalog(
    [providerForTarget(definition.modelRoute[0])],
    [definition],
    0,
  );
  assert.lengthOf(catalog.personas, 1);
  assert.equal(catalog.personas[0]?.personaId, "team-researcher");
  assert.equal(catalog.personas[0]?.availability.status, "available");
  assert.notProperty(catalog.personas[0], "instructions");
  assert.deepEqual(buildAgentPersonaCatalog([], [], 0), { personas: [] });
});

it("reports exhausted entries in order and skips only observed future quota exhaustion", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const base = listBuiltInAgentPersonas()[0]!;
  const selection = { instanceId: ProviderInstanceId.make("quota"), model: "quota-model" };
  const ready = provider({
    instanceId: "quota",
    driver: "codex",
    models: [{ slug: "quota-model", name: "Quota", isCustom: false, capabilities: {} }],
  });
  const later = { ...ready, instanceId: ProviderInstanceId.make("later") };
  const definition = {
    ...base,
    modelRoute: [selection, { ...selection, instanceId: later.instanceId }] as const,
  };
  const limits = (
    reset: string | undefined,
    unavailable?: "probeFailed" | "unsupported",
  ): NonNullable<ServerProvider["usageLimits"]> => ({
    checkedAt: "2026-11-03T12:00:00Z",
    windows: [
      {
        id: "primary",
        kind: "session",
        label: "Session",
        usedPercent: 100,
        ...(reset === undefined ? {} : { resetsAt: reset }),
      },
    ],
    ...(unavailable === undefined ? {} : { unavailable: { reason: unavailable } }),
  });
  for (const [usageLimits, expected] of [
    [limits("2026-11-03T13:00:00Z"), "later"],
    [limits("2026-11-03T13:00:00Z", "probeFailed"), "later"],
    [limits("2026-11-03T11:00:00Z"), "quota"],
    [limits(undefined), "quota"],
    [limits("2026-11-03T13:00:00Z", "unsupported"), "quota"],
  ] as const) {
    const result = resolveAgentPersonaRoute({
      now,
      personaId: base.id,
      definition,
      providers: [{ ...ready, usageLimits }, later],
    });
    assert.equal(result.status, "available");
    if (result.status === "available")
      assert.equal(String(result.modelSelection.instanceId), expected);
  }
  const blocked = resolveAgentPersonaRoute({
    now,
    personaId: base.id,
    definition: {
      ...definition,
      modelRoute: [
        { ...selection, instanceId: ProviderInstanceId.make("absent") },
        selection,
        { ...selection, model: "missing-model" },
      ],
    },
    providers: [{ ...ready, usageLimits: limits("2026-11-03T13:00:00Z") }],
  });
  assert.equal(blocked.status, "unavailable");
  if (blocked.status === "unavailable")
    assert.deepEqual(
      blocked.attempts.map(({ failures }) => failures.map(({ code }) => code)),
      [["provider-not-configured"], ["usage-limit"], ["model-not-advertised"]],
    );
});

it("keeps a valid boolean thinking option separate from another option rejection", () => {
  const configured = provider({
    instanceId: "boolean",
    driver: "claudeAgent",
    models: [
      {
        slug: "thinking-model",
        name: "Thinking",
        isCustom: false,
        capabilities: {
          optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
        },
      },
    ],
  });
  const code = agentPersonaTargetUnavailableReason(
    configured,
    {
      instanceId: configured.instanceId,
      model: "thinking-model",
      options: [
        { id: "thinking", value: true },
        { id: "missing", value: "value" },
      ],
    },
    0,
  );
  assert.equal(code, "option-not-advertised");
});

it("projects a new list for old readers while keeping its complete instance entries", () => {
  const { authority: _authority, ...legacy } = listBuiltInAgentPersonas()[0]!;
  const definition = decodeAgentPersonaDefinition({
    ...legacy,
    access: "read-only",
    artifacts: false,
    inputArtifacts: 42,
    outputArtifact: {},
    modelRoute: [
      { instanceId: "missing", model: "first" },
      { instanceId: "codex", model: "second", options: [{ id: "reasoningEffort", value: "high" }] },
      { instanceId: "codex", model: "third" },
    ],
  });
  const providers = [
    provider({
      instanceId: "codex",
      driver: "codex",
      models: [model("second", "reasoningEffort"), model("third", "reasoningEffort")],
    }),
  ];
  const view = agentPersonaDefinitionView(definition, providers);
  const oldDefinition = Schema.Struct({
    id: Schema.String,
    version: Schema.Number,
    displayName: Schema.String,
    description: Schema.String,
    instructions: Schema.String,
    authority: Schema.Struct({
      defaultPolicy: Schema.String,
      allowedPolicies: Schema.Array(Schema.String),
    }),
    modelRoute: Schema.Tuple([AgentPersonaModelTarget, AgentPersonaModelTarget]),
  });
  const old = Schema.decodeSync(oldDefinition)(view);
  assert.deepEqual(
    old.modelRoute.map(({ model }) => model),
    ["first", "second"],
  );
  assert.equal(old.authority.defaultPolicy, "read-only");
  assert.equal(view.modelRoute[0].driver, "unconfigured");
  const response = decodePersonaRead({
    definition: view,
    fileName: "agent.yaml",
    yaml: yaml(definition),
  });
  assert.lengthOf(response.definition.models!, 3);
  assert.include(response.yaml, "instanceId: missing");
  assert.isFalse("artifacts" in response.definition);
  assert.isFalse("outputArtifact" in response.definition);
  assert.deepEqual(decodeDefinitionView(old).modelRoute, old.modelRoute);
  const resolution = resolveAgentPersonaRoute({
    now: 0,
    personaId: definition.id,
    definition,
    providers,
  });
  assert.equal(resolution.status, "available");
  if (resolution.status !== "available") return;
  const built = buildAgentPersonaAssignment({ resolution, definition });
  assert.equal(built.status, "assigned");
  if (built.status !== "assigned") return;
  assert.equal(built.assignment.resolvedEntryIndex, 1);
  assert.equal(built.assignment.resolvedModelSelection.model, "second");
  assert.isUndefined(validateAgentPersonaAssignment(built.assignment, definition));
});

it("repeats a single model only in the legacy read summary", () => {
  const { authority: _authority, ...legacy } = listBuiltInAgentPersonas()[0]!;
  const definition = decodeAgentPersonaDefinition({
    ...legacy,
    access: "full-access",
    modelRoute: [{ instanceId: "unconfigured", model: "only" }],
  });
  const view = agentPersonaDefinitionView(definition, []);
  assert.lengthOf(view.models!, 1);
  assert.deepEqual(view.modelRoute[0], view.modelRoute[1]);
});

it("retains the third entry index when new-format candidates fail before it", () => {
  const { authority: _authority, ...legacy } = listBuiltInAgentPersonas()[0]!;
  const definition = decodeAgentPersonaDefinition({
    ...legacy,
    access: "workspace-write",
    modelRoute: [
      { instanceId: "codex", model: "missing" },
      { instanceId: "claudeAgent", model: "claude" },
      { instanceId: "codex", model: "available" },
    ],
  });
  const providers = [
    provider({
      instanceId: "codex",
      driver: "codex",
      models: [model("available", "reasoningEffort")],
    }),
    provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      models: [model("claude", "effort")],
    }),
  ];
  const resolution = resolveAgentPersonaRoute({
    now: 0,
    personaId: definition.id,
    definition,
    providers,
  });
  assert.equal(resolution.status, "available");
  if (resolution.status !== "available") return;
  const result = buildAgentPersonaAssignment({ resolution, definition });
  assert.equal(result.status, "assigned");
  if (result.status !== "assigned") return;
  assert.equal(result.assignment.resolvedEntryIndex, 2);
  assert.equal(result.assignment.resolvedModelSelection.model, "available");
  assert.isUndefined(validateAgentPersonaAssignment(result.assignment, definition));
  assert.deepEqual(
    resolution.rejectedTargets.map(({ failures }) => failures[0]?.code),
    ["model-not-advertised", "authority-not-enforceable"],
  );
});

it("keeps blocked instance entries readable by the legacy catalog decoder", () => {
  const oldFailure = Schema.Literals([
    "provider-not-configured",
    "provider-unavailable",
    "provider-disabled",
    "provider-not-installed",
    "provider-error",
    "provider-unauthenticated",
    "model-not-advertised",
    "reasoning-effort-not-advertised",
    "authority-not-enforceable",
  ]);
  const oldCatalog = Schema.Struct({
    personas: Schema.Array(
      Schema.Struct({
        availability: Schema.Struct({
          status: Schema.Literal("unavailable"),
          reason: Schema.Literals([
            "routes-unavailable",
            "authority-not-enforceable",
            "disabled",
            "removed",
          ]),
          attempts: Schema.optional(
            Schema.Array(
              Schema.Struct({
                route: Schema.Literals(["primary", "fallback"]),
                driver: ProviderDriverKind,
                model: Schema.String,
                reasoningEffort: Schema.String,
                failures: Schema.Array(oldFailure),
              }),
            ),
          ),
        }),
      }),
    ),
  });
  const ready = provider({
    instanceId: "codex",
    driver: "codex",
    models: [model("limited", "reasoningEffort")],
  });
  const definition = decodeAgentPersonaDefinition({
    ...listBuiltInAgentPersonas()[0]!,
    modelRoute: [{ instanceId: "codex", model: "limited" }],
  });
  const result = buildAgentPersonaCatalog(
    [
      {
        ...ready,
        usageLimits: {
          checkedAt: "2026-11-03T12:00:00Z",
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: "2026-11-03T13:00:00Z",
            },
          ],
        },
      },
    ],
    [definition],
    Date.parse("2026-11-03T12:00:00Z"),
  );
  assert.deepEqual(result.personas[0]?.modelEntries?.[0]?.failures, ["usage-limit"]);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(oldCatalog)(result));
});

it("ignores Claude model-scoped exhaustion while honoring its account windows", () => {
  const response = {
    rate_limits_available: true,
    rate_limits: {
      seven_day: { utilization: 20, resets_at: "2026-11-03T13:00:00Z" },
      ...({
        model_scoped: [
          { display_name: "Fable", utilization: 100, resets_at: "2026-11-03T13:00:00Z" },
        ],
      } as object),
    },
  };
  const ready = provider({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    models: [model("claude-opus-5", "effort")],
  });
  const target = { instanceId: ready.instanceId, model: "claude-opus-5" };
  const usageLimits = claudeUsageResponseToLimits({ checkedAt: "2026-11-03T12:00:00Z", response });
  assert.isUndefined(
    agentPersonaTargetUnavailableReason(
      { ...ready, usageLimits: usageLimits.limits },
      target,
      Date.parse("2026-11-03T12:00:00Z"),
    ),
  );
  const exhausted = claudeUsageResponseToLimits({
    checkedAt: "2026-11-03T12:00:00Z",
    response: {
      ...response,
      rate_limits: {
        ...response.rate_limits,
        seven_day: { utilization: 100, resets_at: "2026-11-03T13:00:00Z" },
      },
    },
  });
  assert.equal(
    agentPersonaTargetUnavailableReason(
      { ...ready, usageLimits: exhausted.limits },
      target,
      Date.parse("2026-11-03T12:00:00Z"),
    ),
    "usage-limit",
  );
});

it("records the selected entry index in an assignment", () => {
  const definition = decodeAgentPersonaDefinition({
    ...listBuiltInAgentPersonas()[0]!,
    modelRoute: [
      { instanceId: "absent", model: "missing" },
      { instanceId: "absent", model: "missing" },
      { instanceId: "codex", model: "chosen" },
    ],
  });
  const resolution = resolveAgentPersonaRoute({
    now: 0,
    personaId: definition.id,
    definition,
    providers: [
      provider({
        instanceId: "codex",
        driver: "codex",
        models: [model("chosen", "reasoningEffort")],
      }),
    ],
  });
  assert.equal(resolution.status, "available");
  if (resolution.status !== "available") return;
  const result = buildAgentPersonaAssignment({ resolution, definition });
  assert.equal(result.status, "assigned");
  if (result.status !== "assigned") return;
  assert.equal(result.assignment.resolvedEntryIndex, 2);
  assert.isUndefined(validateAgentPersonaAssignment(result.assignment, definition));
});

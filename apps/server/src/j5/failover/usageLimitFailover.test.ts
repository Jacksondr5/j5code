const decodePublicCommand = Schema.decodeUnknownSync(OrchestrationV2PublicCommand);

import * as DateTime from "effect/DateTime";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  ProjectId,
  type ServerProvider,
  type OrchestrationV2AppThread,
  type ServerSettings,
  OrchestrationV2PublicCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { getBuiltInAgentPersona } from "../agents/agentPersonas.ts";
import {
  limitFailoverDecision,
  routeAvailability,
  type LimitFailure,
} from "./usageLimitFailover.ts";

const now = Date.parse("2026-10-23T14:34:18Z");
const a = ProviderInstanceId.make("codex"),
  b = ProviderInstanceId.make("claudeAgent");
const run = RunId.make("run:failed");
const settings: ServerSettings["usageLimitFailover"] = {
  enabled: true,
  maxHops: 4,
  routes: [
    { instanceId: a, model: "test" },
    { instanceId: b, model: "test" },
  ],
  subscriptionOnlyInstances: [a, b],
};
function provider(instanceId = a, used = 0, reset = now + 60_000): ServerProvider {
  const codex = instanceId === a;
  return {
    instanceId,
    driver: ProviderDriverKind.make(codex ? "codex" : "claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    availability: "available",
    slashCommands: [],
    skills: [],
    models: [{ slug: "test", name: "test", isCustom: false, capabilities: {} }],
    supportedRuntimeModes: ["full-access", "approval-required", "auto-accept-edits"],
    usageLimits: {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      completeCheckedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      windows: [
        {
          id: codex ? "primary" : "five_hour",
          kind: "session",
          label: "session",
          usedPercent: used,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(reset)),
        },
        { id: codex ? "secondary" : "seven_day", kind: "weekly", label: "weekly", usedPercent: 0 },
      ],
    },
  };
}
const thread = {
  id: ThreadId.make("thread:test"),
  projectId: ProjectId.make("project:test"),
  providerInstanceId: a,
  modelSelection: { instanceId: a, model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  usageLimitFailoverHops: 0,
} as OrchestrationV2AppThread;
const failed = (id = a, resetAt: number | null = now + 60_000): LimitFailure => ({
  providerInstanceId: id,
  failedAt: now - 1000,
  resetAt,
});
const decide = (
  providers = [provider(a, 100), provider(b)],
  failures = [failed()],
  t = thread,
  time = now,
  config = settings,
) =>
  limitFailoverDecision({
    thread: t,
    failedRunId: run,
    failedProvider: a,
    providers,
    failures,
    settings: config,
    now: time,
  });

describe("usage-limit failover", () => {
  it("S1/S15 chooses Claude without a Captain or any model call", () => {
    const d = decide();
    assert.equal(d.phase, "switch");
    if (d.phase === "switch") assert.equal(d.selection.instanceId, b);
  });
  it("S2-S4 waits for both exhausted providers, then continues whichever is first", () => {
    for (const first of [a, b]) {
      const providers = [provider(a, 100), provider(b, 100)];
      const failures = [failed(a), failed(b)];
      assert.equal(decide(providers, failures).phase, "suspended");
      const recovered = providers.map((p) => (p.instanceId === first ? provider(first) : p));
      assert.equal(decide(recovered, failures).phase, first === a ? "continue" : "switch");
    }
  });
  it("S5/S13 caps hops but still allows recovery on the active provider", () => {
    const t = { ...thread, usageLimitFailoverHops: 4 };
    assert.equal(decide(undefined, undefined, t).phase, "suspended");
    assert.equal(decide([provider(a), provider(b)], [failed()], t).phase, "continue");
  });
  it("S7/S14 never switches a second time for the same failed run", () => {
    const t = {
      ...thread,
      providerInstanceId: b,
      modelSelection: { instanceId: b, model: "test" },
      usageLimitFailoverHops: 1,
    };
    for (let i = 0; i < 10; i++)
      assert.equal(decide([provider(a), provider(b, 100)], [failed()], t).phase, "suspended");
    assert.equal(decide([provider(a), provider(b)], [failed()], t).phase, "continue");
  });
  it("S8/S18/S19 requires a newer fresh complete snapshot after a failure without reset", () => {
    const good = provider();
    assert.isTrue(routeAvailability(good, [failed(a, null)], now));
    for (const limits of [
      undefined,
      { ...good.usageLimits!, windows: [] },
      { ...good.usageLimits!, windows: good.usageLimits!.windows.slice(0, 1) },
      { ...good.usageLimits!, checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 120_000)) },
      { ...good.usageLimits!, unavailable: { reason: "probeFailed" as const } },
      { ...good.usageLimits!, checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 2000)) },
    ]) {
      const stale = { ...good };
      if (limits === undefined) Reflect.deleteProperty(stale, "usageLimits");
      else Reflect.set(stale, "usageLimits", limits);
      assert.isFalse(routeAvailability(stale, [failed(a, null)], now));
    }
  });
  it("S9/S10/S20 shares early-snapshot and reset recovery and honors later exhaustion", () => {
    assert.isTrue(routeAvailability(provider(), [failed()], now));
    assert.isTrue(routeAvailability(provider(a, 100, now - 1), [failed(a, now - 1)], now));
    assert.isFalse(routeAvailability(provider(a, 100), [failed(a, now - 1)], now));
    assert.isFalse(
      routeAvailability(provider(a, 0), [{ ...failed(), resetAt: now - 2000 }], now - 2000),
    );
  });
  it("S11/S12 rejects overage, unattested accounts, unsupported modes and unknown options", () => {
    const overage = provider(b);
    Reflect.set(overage, "usageLimits", {
      ...overage.usageLimits!,
      windows: [
        ...overage.usageLimits!.windows,
        { id: "overage", kind: "other", label: "overage", usedPercent: 1 },
      ],
    });
    assert.equal(decide([provider(a, 100), overage]).phase, "suspended");
    assert.equal(
      decide(undefined, undefined, thread, now, { ...settings, subscriptionOnlyInstances: [] })
        .phase,
      "suspended",
    );
    assert.equal(
      decide([provider(a, 100), { ...provider(b), supportedRuntimeModes: ["approval-required"] }])
        .phase,
      "suspended",
    );
    assert.equal(
      decide(undefined, undefined, thread, now, {
        ...settings,
        routes: [{ instanceId: b, model: "test", options: [{ id: "allow_all", value: true }] }],
      }).phase,
      "suspended",
    );
  });
  it("S17 excludes ACP even if it reports available quota", () => {
    assert.equal(
      decide([provider(a, 100), { ...provider(b), driver: ProviderDriverKind.make("acpRegistry") }])
        .phase,
      "suspended",
    );
  });
  it.each(["builder", "critic"] as const)(
    "S6/S16 preserves %s authority and permits only its declared route",
    (persona) => {
      const definition = getBuiltInAgentPersona(persona);
      const primary = definition.modelRoute[0],
        fallback = definition.modelRoute[1];
      const providers = [primary, fallback].map((target, i) => ({
        ...provider(i === 0 ? a : b, i === 0 ? 100 : 0),
        driver: ProviderDriverKind.make(target.driver),
        models: [
          {
            slug: target.model,
            name: target.model,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: target.driver === "codex" ? "reasoningEffort" : "effort",
                  type: "select" as const,
                  label: "effort",
                  options: [{ id: target.reasoningEffort, label: "effort" }],
                },
              ],
            },
          },
        ],
      }));
      const selection = {
        instanceId: a,
        model: primary.model,
        options: [
          {
            id: primary.driver === "codex" ? "reasoningEffort" : "effort",
            value: primary.reasoningEffort,
          },
        ],
      };
      const assignment = {
        personaId: persona,
        definitionVersion: definition.version,
        authorityPolicy: definition.authority.defaultPolicy,
        resolvedRoute: "primary" as const,
        resolvedDriver: ProviderDriverKind.make(primary.driver),
        resolvedModelSelection: selection,
      };
      const t = { ...thread, modelSelection: selection, agentPersonaAssignment: assignment };
      const input = {
        thread: t,
        failedRunId: run,
        failedProvider: a,
        providers,
        failures: [failed()],
        settings,
        now,
        definition,
      };
      const d = limitFailoverDecision(input);
      assert.equal(d.phase, persona === "builder" ? "suspended" : "switch");
      const approved = limitFailoverDecision({
        ...input,
        thread: {
          ...t,
          agentPersonaAssignment: { ...assignment, runtimeModeOverride: "full-access" },
        },
      });
      assert.equal(approved.phase, "switch");
      if (approved.phase === "switch") {
        assert.equal(approved.assignment?.runtimeModeOverride, "full-access");
        assert.equal(approved.assignment?.authorityPolicy, assignment.authorityPolicy);
      }
      assert.equal(
        limitFailoverDecision({
          ...input,
          thread: { ...t, agentPersonaAssignment: { ...assignment, resolvedRoute: "override" } },
        }).phase,
        "suspended",
      );
    },
  );
  it("excludes the server-owned failover command from public APIs", () => {
    assert.throws(() =>
      decodePublicCommand({
        type: "thread.provider-failover",
        commandId: "x",
        threadId: thread.id,
        failedRunId: run,
        phase: "switch",
      }),
    );
  });
});

it("S6 recovers simultaneous Captain, approved Builder and Critic failures without supervision", () => {
  const definitions = [getBuiltInAgentPersona("builder"), getBuiltInAgentPersona("critic")];
  const providers = [provider(a, 100), provider(b, 100)].map((p) => ({
    ...p,
    models: [
      ...p.models,
      ...definitions.flatMap((d) =>
        d.modelRoute
          .filter((target) => target.driver === p.driver)
          .map((target) => ({
            slug: target.model,
            name: target.model,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: target.driver === "codex" ? "reasoningEffort" : "effort",
                  label: "effort",
                  type: "select" as const,
                  options: [{ id: target.reasoningEffort, label: "effort" }],
                },
              ],
            },
          })),
      ),
    ],
  }));
  const cases = [
    { thread, definition: undefined },
    ...definitions.map((definition) => {
      const primary = definition.modelRoute[0];
      const selection = {
        instanceId: primary.driver === "codex" ? a : b,
        model: primary.model,
        options: [
          {
            id: primary.driver === "codex" ? "reasoningEffort" : "effort",
            value: primary.reasoningEffort,
          },
        ],
      };
      return {
        definition,
        thread: {
          ...thread,
          id: ThreadId.make(`thread:${definition.id}`),
          providerInstanceId: selection.instanceId,
          modelSelection: selection,
          agentPersonaAssignment: {
            personaId: definition.id,
            definitionVersion: definition.version,
            authorityPolicy: definition.authority.defaultPolicy,
            resolvedRoute: "primary" as const,
            resolvedDriver: ProviderDriverKind.make(primary.driver),
            resolvedModelSelection: selection,
            ...(definition.id === "builder" ? { runtimeModeOverride: "full-access" as const } : {}),
          },
        },
      };
    }),
  ];
  for (const first of [a, b])
    for (const current of cases) {
      const input = {
        thread: current.thread,
        ...(current.definition === undefined ? {} : { definition: current.definition }),
        failedRunId: run,
        failedProvider: current.thread.providerInstanceId,
        providers,
        failures: [failed(a), failed(b)],
        settings,
        now,
      };
      assert.equal(limitFailoverDecision(input).phase, "suspended");
      const recovered = providers.map((p) =>
        p.instanceId === first
          ? {
              ...p,
              usageLimits: {
                ...p.usageLimits!,
                windows: p.usageLimits!.windows.map((w) => ({ ...w, usedPercent: 0 })),
              },
            }
          : p,
      );
      assert.equal(
        limitFailoverDecision({ ...input, providers: recovered }).phase,
        current.thread.providerInstanceId === first ? "continue" : "switch",
      );
    }
});

it("S5 waits through staggered failures and resets rather than bouncing between exhausted providers", () => {
  const later = now + 120_000;
  assert.equal(
    decide(
      [provider(a, 100, now + 60_000), provider(b, 100, later)],
      [failed(a, now + 60_000), failed(b, later)],
    ).phase,
    "suspended",
  );
  assert.equal(
    decide(
      [provider(a, 100, now + 60_000), provider(b, 100, later)],
      [failed(a, now + 60_000), failed(b, later)],
      thread,
      now + 60_000,
    ).phase,
    "continue",
  );
  const t = {
    ...thread,
    providerInstanceId: b,
    modelSelection: { instanceId: b, model: "test" },
    usageLimitFailoverHops: 2,
  };
  assert.equal(
    limitFailoverDecision({
      thread: t,
      failedRunId: run,
      failedProvider: b,
      providers: [provider(a, 100, later + 60_000), provider(b, 100, later)],
      failures: [{ ...failed(a, later + 60_000), failedAt: now + 61_000 }, failed(b, later)],
      settings,
      now: now + 70_000,
    }).phase,
    "suspended",
  );
});

it("unknown unfailed alternatives are eligible; a stale pre-failure snapshot cannot override an elapsed reset", () => {
  const unknown = provider(b);
  Reflect.deleteProperty(unknown, "usageLimits");
  assert.isTrue(routeAvailability(unknown, [], now));
  const stale = {
    ...provider(a, 100),
    usageLimits: {
      ...provider(a, 100).usageLimits!,
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 120_000)),
    },
  };
  assert.isTrue(routeAvailability(stale, [failed(a, now - 1)], now));
  assert.isFalse(
    routeAvailability(
      { ...provider(b), usageLimits: { ...provider(b).usageLimits!, paidUsageEnabled: true } },
      [],
      now,
    ),
  );
  assert.equal(
    decide(undefined, undefined, { ...thread, interactionMode: "plan" }).phase,
    "suspended",
  );
});

it("scoped Codex quota exhaustion blocks the whole instance and cannot clear a missing-reset failure", () => {
  const main = provider();
  const scoped = {
    ...main,
    usageLimits: {
      ...main.usageLimits!,
      recoveryWindows: [
        {
          id: "codex_bengalfox:primary",
          kind: "session" as const,
          label: "Spark",
          usedPercent: 100,
        },
      ],
    },
  };
  assert.isFalse(routeAvailability(scoped, [failed(a, null)], now));
});

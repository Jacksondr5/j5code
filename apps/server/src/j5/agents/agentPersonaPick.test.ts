import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { stringify as yaml } from "yaml";

import { ServerConfig } from "../../config.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { agentPersonaEscalationsTestLayer } from "../test-support/agentPersonaEscalations.ts";
import { AgentPersonaEscalations } from "./agentPersonaEscalation.ts";
import { makeAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { pickAgentPersona } from "./agentPersonaPick.ts";
import { BUILT_IN_AGENT_PERSONAS } from "./agentPersonas.ts";
import { CrewMemberModels } from "./crewMemberModels.ts";

const definition = { ...BUILT_IN_AGENT_PERSONAS.scout, id: "team-researcher" };
const [primary] = definition.modelRoute;
const providers = definition.modelRoute.map(
  (target) =>
    ({
      instanceId: ProviderInstanceId.make(target.driver),
      driver: ProviderDriverKind.make(target.driver),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      availability: "available",
      models: [
        {
          slug: target.model,
          name: target.model,
          capabilities: {
            optionDescriptors: [
              {
                id: target.driver === "codex" ? "reasoningEffort" : "effort",
                label: "Reasoning",
                type: "select",
                // The primary's model also offers a second level, for a persona listing both.
                options: [
                  { id: target.reasoningEffort, label: "High" },
                  ...(target === primary ? [{ id: "medium", label: "Medium" }] : []),
                ],
              },
            ],
          },
        },
      ],
    }) as unknown as ServerProvider,
);

const lists = { unchecked: [primary.driver] as Array<string> };
const [, secondary] = definition.modelRoute;
const pinOf = (entry: typeof primary) => ({
  instanceId: ProviderInstanceId.make(entry.driver),
  model: entry.model,
  reasoning: entry.reasoningEffort,
});

const testLayer = Layer.mergeAll(
  Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
  // By default the project's list checks every model but the primary's.
  Layer.mock(CrewMemberModels)({
    eligibility: () =>
      Effect.succeed((selection) => !lists.unchecked.includes(String(selection.instanceId))),
  }),
  Layer.mock(ThreadManagementService)({}),
  agentPersonaEscalationsTestLayer(),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-persona-pick-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("a pinned entry that can't run escalates instead of falling back", () =>
  Effect.gen(function* () {
    lists.unchecked = [primary.driver];
    yield* (yield* makeAgentPersonaLibrary).importFiles({
      files: [{ name: "researcher.yaml", content: yaml(definition) }],
      replaceExisting: false,
    });
    const pick = (pinned: boolean) =>
      pickAgentPersona({
        personaId: definition.id,
        source: "agent",
        caller: { approvedLevel: "full-access" },
        projectId: ProjectId.make("project"),
        escalateFor: "agent:j5:a2a:thread:caller",
        ...(pinned
          ? {
              pinned: {
                instanceId: ProviderInstanceId.make(primary.driver),
                model: primary.model,
                reasoning: primary.reasoningEffort,
              },
            }
          : {}),
      });
    // Left to the server, the list moves on to the entry the project checks.
    const unpinned = yield* pick(false);
    assert.equal(unpinned.assignment.resolvedEntryIndex, 1);

    const refused = yield* pick(true).pipe(Effect.flip);
    assert.equal(refused.code, "models_exhausted");
    assert.equal(refused.constraint, "model-not-eligible");
    assert.isDefined(refused.escalationId);
    assert.include(refused.message, `escalation_id: ${refused.escalationId}`);
    assert.include(refused.message, "is not checked in Models for custom members");
  }).pipe(Effect.provide(testLayer)),
);

const importDefinition = (content: object) =>
  Effect.gen(function* () {
    yield* (yield* makeAgentPersonaLibrary).importFiles({
      files: [{ name: "researcher.yaml", content: yaml(content) }],
      replaceExisting: true,
    });
  });
const agentPick = (extra: Partial<Parameters<typeof pickAgentPersona>[0]>) =>
  pickAgentPersona({
    personaId: definition.id,
    source: "agent",
    caller: { approvedLevel: "full-access" },
    projectId: ProjectId.make("project"),
    escalateFor: "agent:j5:a2a:thread:caller",
    ...extra,
  });
const grant = (escalationId: string | undefined) =>
  Effect.gen(function* () {
    yield* (yield* AgentPersonaEscalations).markGranted({
      escalationId: escalationId!,
      grantedBy: "human:owner",
    });
    return escalationId!;
  });

it.effect("an allowance covers only the model the person was shown", () =>
  Effect.gen(function* () {
    lists.unchecked = [primary.driver, secondary!.driver];
    yield* importDefinition(definition);
    const refused = yield* agentPick({ pinned: pinOf(primary) }).pipe(Effect.flip);
    const allowOnce = yield* grant(refused.escalationId);

    // The cheap entry was allowed; the expensive one is refused, and the allowance stays.
    const other = yield* agentPick({ pinned: pinOf(secondary!), allowOnce }).pipe(Effect.flip);
    assert.equal(other.code, "models_exhausted");
    assert.include(other.message, `allow_once ${allowOnce} covers only`);
    const allowed = yield* agentPick({ pinned: pinOf(primary), allowOnce });
    assert.deepEqual(allowed.assignment.pickSource, {
      kind: "allow-once",
      waived: "model-not-eligible",
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("an allowance never covers broader access than the refusal showed", () =>
  Effect.gen(function* () {
    lists.unchecked = [];
    yield* importDefinition(definition);
    // A Crew seat's own access, above its Supervised Captain.
    const seat = (runtimeMode: "auto-accept-edits" | "full-access", allowOnce?: string) =>
      agentPick({
        caller: { approvedLevel: "approval-required" },
        runtimeMode,
        ...(allowOnce === undefined ? {} : { allowOnce }),
      });
    const refused = yield* seat("auto-accept-edits").pipe(Effect.flip);
    assert.equal(refused.constraint, "access-above-caller");
    const allowOnce = yield* grant(refused.escalationId);

    const broader = yield* seat("full-access", allowOnce).pipe(Effect.flip);
    assert.include(broader.message, "at Auto-accept edits; this launch asks for Full access");
    assert.isUndefined(broader.code);
    const allowed = yield* seat("auto-accept-edits", allowOnce);
    assert.deepEqual(allowed.assignment.pickSource, {
      kind: "allow-once",
      waived: "access-above-caller",
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("an allowance ends when the persona's definition changes", () =>
  Effect.gen(function* () {
    lists.unchecked = [primary.driver, secondary!.driver];
    yield* importDefinition(definition);
    const refused = yield* agentPick({ pinned: pinOf(primary) }).pipe(Effect.flip);
    const allowOnce = yield* grant(refused.escalationId);
    yield* importDefinition({ ...definition, instructions: "Edited after the person allowed it." });
    const stale = yield* agentPick({ pinned: pinOf(primary), allowOnce }).pipe(Effect.flip);
    assert.include(stale.message, "earlier version of persona team-researcher's definition");
    assert.isUndefined(stale.code);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("an allowance covers only the reasoning level the person was shown", () =>
  Effect.gen(function* () {
    lists.unchecked = [primary.driver];
    const leveled = {
      ...definition,
      modelRoute: [
        { ...primary, reasoningEffort: "medium" },
        { ...primary, reasoningEffort: primary.reasoningEffort },
      ],
    };
    yield* importDefinition(leveled);
    const at = (reasoningEffort: string, allowOnce?: string) =>
      agentPick({
        pinned: pinOf({ ...primary, reasoningEffort }),
        ...(allowOnce === undefined ? {} : { allowOnce }),
      });
    const refused = yield* at("medium").pipe(Effect.flip);
    const allowOnce = yield* grant(refused.escalationId);

    const higher = yield* at(primary.reasoningEffort, allowOnce).pipe(Effect.flip);
    assert.include(higher.message, `allow_once ${allowOnce} covers only`);
    const allowed = yield* at("medium", allowOnce);
    assert.deepEqual(allowed.assignment.pickSource, {
      kind: "allow-once",
      waived: "model-not-eligible",
    });
  }).pipe(Effect.provide(testLayer)),
);

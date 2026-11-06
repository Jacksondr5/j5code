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
                options: [{ id: target.reasoningEffort, label: "High" }],
              },
            ],
          },
        },
      ],
    }) as unknown as ServerProvider,
);

const testLayer = Layer.mergeAll(
  Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
  // The project's list checks every model but the primary's.
  Layer.mock(CrewMemberModels)({
    eligibility: () =>
      Effect.succeed(
        (selection) => selection.instanceId !== ProviderInstanceId.make(primary.driver),
      ),
  }),
  Layer.mock(ThreadManagementService)({}),
  agentPersonaEscalationsTestLayer(),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-persona-pick-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("a pinned entry that can't run escalates instead of falling back", () =>
  Effect.gen(function* () {
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

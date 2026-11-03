import type { ProviderInstanceId } from "@t3tools/contracts";
import { AgentPersonaUsageLimits } from "../agents/agentPersonaUsageLimits.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { stringify as yaml } from "yaml";

import { ServerConfig } from "../../config.ts";
import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import type { AgentPersonaDefinition } from "../agents/agentPersonas.ts";

/** Tests opt into their persona definitions through the same import path as a person. */
export const personaLibraryLayer = (
  prefix: string,
  definitions: ReadonlyArray<AgentPersonaDefinition>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const library = yield* makeAgentPersonaLibrary;
      yield* library.importFiles({
        files: definitions.map((definition) => ({
          name: `${definition.id}.yaml`,
          content: yaml(definition),
        })),
        replaceExisting: false,
      });
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(AgentPersonaUsageLimits, {
        limitedInstances: Effect.fn("AgentPersonaUsageLimits.limitedInstances")(() =>
          Effect.succeed(new Set<ProviderInstanceId>()),
        ),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

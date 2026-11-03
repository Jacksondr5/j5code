import { type ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import type { AgentPersonaLibraryError } from "./agentPersonaLibrary.ts";

export class AgentPersonaUsageLimits extends Context.Service<
  AgentPersonaUsageLimits,
  {
    readonly limitedInstances: (
      now: number,
    ) => Effect.Effect<ReadonlySet<ProviderInstanceId>, AgentPersonaLibraryError>;
  }
>()("t3/j5/agents/agentPersonaUsageLimits") {}

const make = Effect.gen(function* () {
  const projections = yield* ThreadManagementService;
  return AgentPersonaUsageLimits.of({
    limitedInstances: projections.getPersonaUsageLimitedProviderInstances,
  });
});

export const layer = Layer.effect(AgentPersonaUsageLimits, make);

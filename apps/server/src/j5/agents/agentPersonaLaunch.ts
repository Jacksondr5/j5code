import { agentPersonaPolicy, mapAgentPersonaPolicy } from "./agentPersonas.ts";
import { AgentPersonaUsageLimits } from "./agentPersonaUsageLimits.ts";
import * as Clock from "effect/Clock";
import type {
  OrchestrationV2AgentPersonaRequest,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { buildAgentPersonaAssignment } from "./agentPersonaAssignment.ts";
import { AgentPersonaLibraryError, type createAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { resolveAgentPersonaRoute, type AgentPersonaRouteAttempt } from "./agentPersonaRouting.ts";

const routeFailurePhrase = (
  target: AgentPersonaRouteAttempt["target"],
  failure: AgentPersonaRouteAttempt["failures"][number],
) => {
  const provider = "driver" in target ? target.driver : target.instanceId;
  switch (failure.code) {
    case "provider-not-configured":
      return `no ${provider} provider is configured`;
    case "provider-unavailable":
      return `${provider} is unavailable`;
    case "provider-disabled":
      return `${provider} is disabled`;
    case "provider-not-installed":
      return `${provider} is not installed`;
    case "provider-error":
      return `${provider} reports an error`;
    case "provider-unauthenticated":
      return `${provider} is signed out`;
    case "model-not-advertised":
      return `${provider} does not advertise ${target.model}`;
    case "reasoning-effort-not-advertised":
      return `${provider} does not advertise reasoning effort ${"reasoningEffort" in target ? target.reasoningEffort : "requested"} for ${target.model}`;
    case "usage-limit":
      return `${provider} is at its usage limit`;
    case "option-not-advertised":
      return `${provider} does not support the requested model options`;
    case "authority-not-enforceable":
      return `${provider} cannot enforce the persona's authority policy`;
  }
};

/**
 * Why each route was refused, so the person who approved a seat (or the agent that asked for one)
 * learns "codex is signed out" rather than "unavailable" (Jackson's dogfood, 2026-09-17).
 */
const describeRouteAttempts = (attempts: ReadonlyArray<AgentPersonaRouteAttempt>) =>
  attempts
    .map(
      (attempt) =>
        `entry ${attempt.entryIndex + 1} ${attempt.target.model} (${[
          ...new Set(
            attempt.failures.map((failure) => routeFailurePhrase(attempt.target, failure)),
          ),
        ].join(", ")})`,
    )
    .join("; ");

/** Resolve once and save the exact definition before the ordinary durable thread-creation command. */
export const prepareAgentPersonaLaunch = Effect.fn("prepareAgentPersonaLaunch")(function* (
  request: OrchestrationV2AgentPersonaRequest,
  providers: ReadonlyArray<ServerProvider>,
  library: ReturnType<typeof createAgentPersonaLibrary>,
  quotaSnapshot?: {
    readonly now: number;
    readonly limitedInstances: ReadonlySet<ProviderInstanceId>;
  },
) {
  const catalog = yield* library.catalog();
  if (catalog.disabledIds.includes(request.personaId))
    return yield* new AgentPersonaLibraryError({
      message: "Persona is disabled in this environment.",
    });
  const definition = catalog.definitions.find(({ id }) => id === request.personaId);
  if (definition === undefined)
    return yield* new AgentPersonaLibraryError({
      message: "Unknown persona in this environment.",
    });
  if (
    request.authorityPolicy !== undefined &&
    mapAgentPersonaPolicy(request.authorityPolicy) !== agentPersonaPolicy(definition)
  ) {
    return yield* new AgentPersonaLibraryError({
      message: `Authority policy ${request.authorityPolicy} is not allowed for ${request.personaId}.`,
    });
  }
  const authority =
    request.authorityPolicy === undefined ? {} : { authorityPolicy: request.authorityPolicy };
  const now = quotaSnapshot?.now ?? (yield* Clock.currentTimeMillis);
  const limitedInstances =
    quotaSnapshot?.limitedInstances ??
    (yield* (yield* AgentPersonaUsageLimits).limitedInstances(now));
  const resolution = resolveAgentPersonaRoute({
    now,
    limitedInstances,
    personaId: request.personaId,
    ...authority,
    definition,
    providers,
  });
  if (resolution.status === "unavailable") {
    return yield* new AgentPersonaLibraryError({
      message: `Persona ${request.personaId} is blocked because its ordered model entries are unavailable: ${describeRouteAttempts(resolution.attempts)}.`,
    });
  }
  const result = buildAgentPersonaAssignment({ ...authority, definition, resolution });
  if (result.status !== "assigned")
    return yield* new AgentPersonaLibraryError({
      message: "The selected persona authority is unsupported.",
    });
  const definitionDigest = yield* library.snapshot(definition);
  return {
    ...result.assignment,
    ...(definitionDigest === undefined
      ? {}
      : { definitionDigest, displayName: definition.displayName }),
  };
});

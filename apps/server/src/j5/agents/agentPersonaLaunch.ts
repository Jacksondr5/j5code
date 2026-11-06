import { agentPersonaPolicy, mapAgentPersonaPolicy } from "./agentPersonas.ts";
import * as Clock from "effect/Clock";
import type { OrchestrationV2AgentPersonaRequest, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { buildAgentPersonaAssignment } from "./agentPersonaAssignment.ts";
import { AgentPersonaLibraryError, type createAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import {
  resolveAgentPersonaRoute,
  singleWaivableConstraint,
  type AgentPersonaPickLimits,
  type AgentPersonaRouteAttempt,
} from "./agentPersonaRouting.ts";

export const routeFailurePhrase = (
  target: AgentPersonaRouteAttempt["target"],
  failure: AgentPersonaRouteAttempt["failures"][number],
  provider: string = "driver" in target ? target.driver : target.instanceId,
) => {
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
    case "model-not-eligible":
      return `${target.model} on ${provider} is not checked in Models for custom members`;
    case "access-above-caller":
      return `on ${provider} it would run with broader access than its caller`;
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
            attempt.failures.map(
              (failure) => failure.detail ?? routeFailurePhrase(attempt.target, failure),
            ),
          ),
        ].join(", ")})`,
    )
    .join("; ");

/**
 * The definition a launch names, or why there is none to launch: the library can't be read or is
 * empty, or the persona is disabled, invalid, or not in it.
 */
export const findAgentPersonaDefinition = Effect.fn("j5.agents.findAgentPersonaDefinition")(
  function* (personaId: string, library: ReturnType<typeof createAgentPersonaLibrary>) {
    const catalog = yield* library.catalog().pipe(
      Effect.mapError(
        (error) =>
          new AgentPersonaLibraryError({
            code: "library_unreadable",
            message: `The persona library cannot be read: ${error.message}`,
          }),
      ),
    );
    if (catalog.disabledIds.includes(personaId))
      return yield* new AgentPersonaLibraryError({
        code: "persona_disabled",
        message: `Persona ${personaId} is disabled in this environment.`,
      });
    const definition = catalog.definitions.find(({ id }) => id === personaId);
    if (definition !== undefined) return definition;
    const invalid = catalog.diagnostics.find((diagnostic) => diagnostic.personaId === personaId);
    if (invalid !== undefined)
      return yield* new AgentPersonaLibraryError({
        code: "persona_invalid",
        message: `Persona ${personaId} has an invalid definition (${invalid.path}): ${invalid.message}`,
      });
    return yield* new AgentPersonaLibraryError(
      catalog.definitions.length === 0
        ? {
            code: "library_empty",
            message: `This environment has no personas, so ${personaId} cannot launch.`,
          }
        : {
            code: "persona_not_found",
            message: `Unknown persona ${personaId} in this environment.`,
          },
    );
  },
);

/** The refusal for a persona none of whose entries can run, with each entry's reasons. */
const modelsExhaustedError = (
  personaId: string,
  attempts: ReadonlyArray<AgentPersonaRouteAttempt>,
) => {
  const constraint = singleWaivableConstraint(attempts);
  return new AgentPersonaLibraryError({
    code: "models_exhausted",
    message: `Persona ${personaId} is blocked because none of its model entries can run: ${describeRouteAttempts(attempts)}.`,
    ...(constraint === null ? {} : { constraint }),
  });
};

/** Resolve once and save the exact definition before the ordinary durable thread-creation command. */
export const prepareAgentPersonaLaunch = Effect.fn("prepareAgentPersonaLaunch")(function* (
  request: OrchestrationV2AgentPersonaRequest,
  providers: ReadonlyArray<ServerProvider>,
  library: ReturnType<typeof createAgentPersonaLibrary>,
  limits?: AgentPersonaPickLimits,
  avoidModels?: ReadonlySet<string>,
) {
  const definition = yield* findAgentPersonaDefinition(request.personaId, library);
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
  const now = yield* Clock.currentTimeMillis;
  const resolution = resolveAgentPersonaRoute({
    now,
    personaId: request.personaId,
    ...authority,
    definition,
    providers,
    limits,
    avoidModels,
  });
  if (resolution.status === "unavailable")
    return yield* modelsExhaustedError(request.personaId, resolution.attempts);
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

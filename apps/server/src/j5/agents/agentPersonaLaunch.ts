import type { OrchestrationV2AgentPersonaRequest, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { buildAgentPersonaAssignment } from "./agentPersonaAssignment.ts";
import { AgentPersonaLibraryError, type createAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import {
  resolveAgentPersonaRoute,
  unavailableAgentPersonaReason,
  type AgentPersonaRouteAttempt,
} from "./agentPersonaRouting.ts";

const routeFailurePhrase = (
  target: AgentPersonaRouteAttempt["target"],
  failure: AgentPersonaRouteAttempt["failures"][number],
) => {
  switch (failure.code) {
    case "provider-not-configured":
      return `no ${target.driver} provider is configured`;
    case "provider-unavailable":
      return `${target.driver} is unavailable`;
    case "provider-disabled":
      return `${target.driver} is disabled`;
    case "provider-not-installed":
      return `${target.driver} is not installed`;
    case "provider-error":
      return `${target.driver} reports an error`;
    case "provider-unauthenticated":
      return `${target.driver} is signed out`;
    case "model-not-advertised":
      return `${target.driver} does not advertise ${target.model}`;
    case "reasoning-effort-not-advertised":
      return `${target.driver} does not advertise reasoning effort ${target.reasoningEffort} for ${target.model}`;
    case "authority-not-enforceable":
      return `${target.driver} cannot enforce the persona's authority policy`;
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
        `${attempt.route} ${attempt.target.model} (${[
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
) {
  const catalog = yield* library.catalog();
  if (catalog.disabledIds.includes(request.personaId))
    return yield* new AgentPersonaLibraryError({
      message: "Agent persona is disabled in this environment.",
    });
  const definition = catalog.definitions.find(({ id }) => id === request.personaId);
  if (definition === undefined)
    return yield* new AgentPersonaLibraryError({
      message: "Unknown agent persona in this environment.",
    });
  if (
    request.authorityPolicy !== undefined &&
    !definition.authority.allowedPolicies.includes(request.authorityPolicy)
  ) {
    return yield* new AgentPersonaLibraryError({
      message: `Authority policy ${request.authorityPolicy} is not allowed for ${request.personaId}.`,
    });
  }
  const authority =
    request.authorityPolicy === undefined ? {} : { authorityPolicy: request.authorityPolicy };
  const resolution = resolveAgentPersonaRoute({
    personaId: request.personaId,
    ...authority,
    definition,
    providers,
  });
  if (resolution.status === "unavailable") {
    return yield* new AgentPersonaLibraryError({
      message:
        unavailableAgentPersonaReason(resolution) === "authority-not-enforceable"
          ? `Agent persona ${request.personaId} is blocked because neither route can enforce its authority policy.`
          : `Agent persona ${request.personaId} is blocked because its primary and fallback models are unavailable: ${describeRouteAttempts(resolution.attempts)}.`,
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

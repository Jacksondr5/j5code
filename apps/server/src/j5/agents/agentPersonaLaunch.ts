import type { OrchestrationV2AgentPersonaRequest, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { buildAgentPersonaAssignment } from "./agentPersonaAssignment.ts";
import { AgentPersonaLibraryError, type createAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { resolveAgentPersonaRoute, unavailableAgentPersonaReason } from "./agentPersonaRouting.ts";

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
          : `Agent persona ${request.personaId} is blocked because its primary and fallback models are unavailable.`,
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

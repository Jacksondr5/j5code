import * as Clock from "effect/Clock";
import {
  isAgentPersonaReasoningOptionId,
  agentPersonaReasoningDescriptor,
} from "@t3tools/contracts";
import type {
  OrchestrationV2AgentPersonaCommandAssignment,
  ProviderInstanceId,
  ServerProvider,
  AgentPersonaModelEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { buildAgentPersonaAssignment } from "./agentPersonaAssignment.ts";
import { AgentPersonaLibraryError, type createAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import {
  agentPersonaModelSelection,
  agentPersonaEntryMatches,
  agentPersonaTargetUnavailableReason,
} from "./agentPersonaRouting.ts";
import { agentPersonaPolicy, type AgentPersonaId } from "./agentPersonas.ts";

type Library = ReturnType<typeof createAgentPersonaLibrary>;

const describeTarget = (target: AgentPersonaModelEntry) =>
  "driver" in target
    ? `${target.driver} ${target.model} (${target.reasoningEffort})`
    : `${target.instanceId} ${target.model}`;

export interface AgentPersonaPeerSpawnRequest {
  readonly personaId: AgentPersonaId;
  /** The spawner's explicit provider instance; `undefined` when the registry does not know it. */
  readonly provider: ServerProvider | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  /** Left out for a model with no reasoning option. Entries without a declared reasoning option accept an explicit supported level. */
  readonly reasoning?: string | undefined;
}

/**
 * Role-ful Peer Agent spawn (SP3): provider, model, and reasoning stay the spawner's explicit
 * choice, and the saved agent's declared routes constrain it. An out-of-route pick is an error
 * naming the agent, never a silent substitution. The matching route becomes the immutable
 * assignment, snapshotted exactly like a composer launch.
 */
export const prepareAgentPersonaPeerSpawn = Effect.fn("j5.prepareAgentPersonaPeerSpawn")(function* (
  request: AgentPersonaPeerSpawnRequest,
  library: Library,
) {
  const catalog = yield* library.catalog();
  if (catalog.disabledIds.includes(request.personaId)) {
    return yield* new AgentPersonaLibraryError({
      message: `Agent ${request.personaId} is disabled in this environment.`,
    });
  }
  const definition = catalog.definitions.find(({ id }) => id === request.personaId);
  if (definition === undefined) {
    return yield* new AgentPersonaLibraryError({
      message: `Unknown agent ${request.personaId} in this environment.`,
    });
  }
  const provider = request.provider;
  if (provider === undefined) {
    return yield* new AgentPersonaLibraryError({
      message: `Provider ${request.instanceId} is not configured in this environment.`,
    });
  }
  const reasoningDescriptor = agentPersonaReasoningDescriptor(
    provider.models.find(({ slug }) => slug === request.model),
  );
  const index = definition.modelRoute.findIndex((target) => {
    const options = "options" in target ? (target.options ?? []) : [];
    const reasoning = options.find(({ id }) => id === reasoningDescriptor?.id);
    if ("instanceId" in target)
      return (
        target.instanceId === request.instanceId &&
        target.model === request.model &&
        (reasoning === undefined || reasoning.value === request.reasoning)
      );
    return agentPersonaEntryMatches(
      target,
      {
        instanceId: request.instanceId,
        model: request.model,
        options:
          request.reasoning === undefined
            ? []
            : [{ id: "reasoningEffort", value: request.reasoning }],
      },
      provider.driver,
    );
  });
  const target = definition.modelRoute[index];
  if (target === undefined) {
    return yield* new AgentPersonaLibraryError({
      message: `Agent ${request.personaId} allows only ${definition.modelRoute
        .map(describeTarget)
        .join(
          " or ",
        )}; ${provider.driver} ${request.model} (${request.reasoning ?? "no reasoning"}) is outside its declared routes.`,
    });
  }
  const unavailable = agentPersonaTargetUnavailableReason(
    provider,
    target,
    yield* Clock.currentTimeMillis,
  );
  if (unavailable !== undefined) {
    return yield* new AgentPersonaLibraryError({
      message: `Agent ${request.personaId} route ${describeTarget(target)} is unavailable on provider ${request.instanceId}: ${unavailable}.`,
    });
  }
  const declaredSelection = agentPersonaModelSelection(provider, target);
  const descriptor = agentPersonaReasoningDescriptor(
    provider.models.find(({ slug }) => slug === request.model),
  );
  const modelSelection =
    "instanceId" in target &&
    request.reasoning !== undefined &&
    descriptor !== undefined &&
    !declaredSelection.options?.some(({ id }) => isAgentPersonaReasoningOptionId(id))
      ? {
          ...declaredSelection,
          options: [
            ...(declaredSelection.options ?? []),
            { id: descriptor.id, value: request.reasoning },
          ],
        }
      : declaredSelection;
  const selectionProblem = agentPersonaTargetUnavailableReason(
    provider,
    modelSelection,
    yield* Clock.currentTimeMillis,
  );
  if (selectionProblem !== undefined)
    return yield* new AgentPersonaLibraryError({
      message: `Agent ${request.personaId} model options are unavailable: ${selectionProblem}.`,
    });
  const result = buildAgentPersonaAssignment({
    definition,
    resolution: {
      status: "available",
      personaId: definition.id,
      definitionVersion: definition.version,
      route: index === 0 ? "primary" : "fallback",
      entryIndex: index,
      driver: provider.driver,
      modelSelection,
      rejectedTargets: [],
    },
  });
  if (result.status !== "assigned") {
    return yield* new AgentPersonaLibraryError({
      message: `Agent ${request.personaId} cannot enforce its ${agentPersonaPolicy(definition)} permissions on ${provider.driver}.`,
    });
  }
  const definitionDigest = yield* library.snapshot(definition);
  const assignment: OrchestrationV2AgentPersonaCommandAssignment = {
    ...result.assignment,
    ...(definitionDigest === undefined
      ? {}
      : { definitionDigest, displayName: definition.displayName }),
  };
  return assignment;
});

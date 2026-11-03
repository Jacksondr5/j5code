import { modelSelectionsEqual } from "@t3tools/shared/model";
import {
  isAgentPersonaReasoningOptionId,
  isAgentPersonaAuthorityPolicy,
  type OrchestrationV2AgentPersonaAssignment,
  type OrchestrationV2AgentPersonaCommandAssignment,
  ProviderDriverKind,
} from "@t3tools/contracts";

import type { AgentPersonaRouteResolution } from "./agentPersonaRouting.ts";
import { providerCanEnforceAgentPersonaAuthority } from "./agentPersonaProviderPolicy.ts";
import {
  getBuiltInAgentPersona,
  agentPersonaPolicy,
  mapAgentPersonaPolicy,
  type AgentAuthorityPolicyId,
  type AgentPersonaId,
  type AgentPersonaDefinition,
} from "./agentPersonas.ts";

type AvailableAgentPersonaRoute = Extract<AgentPersonaRouteResolution, { status: "available" }>;

export type AgentPersonaAssignmentResult =
  | {
      readonly status: "assigned";
      readonly assignment: OrchestrationV2AgentPersonaCommandAssignment;
    }
  | {
      readonly status: "invalid-authority-policy";
      readonly personaId: AgentPersonaId;
      readonly requestedPolicy: AgentAuthorityPolicyId;
      readonly allowedPolicies: ReadonlyArray<AgentAuthorityPolicyId>;
    }
  | {
      readonly status: "authority-not-enforceable";
      readonly personaId: AgentPersonaId;
      readonly requestedPolicy: AgentAuthorityPolicyId;
      readonly driver: AvailableAgentPersonaRoute["driver"];
    };

export function buildAgentPersonaAssignment(input: {
  readonly resolution: AvailableAgentPersonaRoute;
  readonly definition?: AgentPersonaDefinition;
  readonly authorityPolicy?: AgentAuthorityPolicyId;
}): AgentPersonaAssignmentResult {
  const definition = input.definition ?? getBuiltInAgentPersona(input.resolution.personaId);
  const authorityPolicy = input.authorityPolicy ?? agentPersonaPolicy(definition);
  if (mapAgentPersonaPolicy(authorityPolicy) !== agentPersonaPolicy(definition)) {
    return {
      status: "invalid-authority-policy",
      personaId: definition.id,
      requestedPolicy: authorityPolicy,
      allowedPolicies: [agentPersonaPolicy(definition)],
    };
  }
  if (!providerCanEnforceAgentPersonaAuthority(input.resolution.driver, authorityPolicy)) {
    return {
      status: "authority-not-enforceable",
      personaId: definition.id,
      requestedPolicy: authorityPolicy,
      driver: input.resolution.driver,
    };
  }

  return {
    status: "assigned",
    assignment: {
      personaId: definition.id,
      definitionVersion: definition.version,
      authorityPolicy: mapAgentPersonaPolicy(authorityPolicy),
      ...(input.resolution.index === undefined
        ? {}
        : { resolvedRouteIndex: input.resolution.index }),
      resolvedRoute: input.resolution.route,
      resolvedDriver: ProviderDriverKind.make(input.resolution.driver),
      resolvedModelSelection: input.resolution.modelSelection,
    },
  };
}

export function validateAgentPersonaAssignment(
  assignment: OrchestrationV2AgentPersonaAssignment,
  definition: AgentPersonaDefinition = getBuiltInAgentPersona(assignment.personaId),
): string | undefined {
  if (assignment.definitionVersion !== definition.version) {
    return "Persona assignment uses an unknown definition version.";
  }
  if (
    !isAgentPersonaAuthorityPolicy(assignment.authorityPolicy) ||
    mapAgentPersonaPolicy(assignment.authorityPolicy) !== agentPersonaPolicy(definition)
  ) {
    return "Persona assignment uses an authority policy outside its definition.";
  }
  if (
    assignment.runtimeModeOverride === undefined &&
    !providerCanEnforceAgentPersonaAuthority(assignment.resolvedDriver, assignment.authorityPolicy)
  ) {
    return "Persona assignment targets a provider that cannot enforce its authority policy.";
  }
  if (assignment.resolvedRoute === "override") {
    return assignment.definitionDigest === undefined
      ? "Human runtime overrides require a saved persona snapshot."
      : undefined;
  }
  const target =
    definition.modelRoute[
      assignment.resolvedRouteIndex ?? (assignment.resolvedRoute === "primary" ? 0 : 1)
    ];
  if (target === undefined) return "Persona assignment does not match its declared model route.";
  if ("instanceId" in target) {
    return modelSelectionsEqual(assignment.resolvedModelSelection, target)
      ? undefined
      : "Persona assignment does not match its declared model route.";
  }
  // Launches carry exactly one reasoning option; a second one would leave the provider's choice ambiguous.
  const reasoningOptions = (assignment.resolvedModelSelection.options ?? []).filter(({ id }) =>
    isAgentPersonaReasoningOptionId(id),
  );
  if (
    assignment.resolvedDriver !== target.driver ||
    assignment.resolvedModelSelection.model !== target.model ||
    reasoningOptions.length !== 1 ||
    reasoningOptions[0]?.value !== target.reasoningEffort
  ) {
    return "Persona assignment does not match its declared model route.";
  }
  return undefined;
}

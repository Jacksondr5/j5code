import { type OrchestrationV2AgentPersonaAssignment, ProviderDriverKind } from "@t3tools/contracts";

import type { AgentPersonaRouteResolution } from "./agentPersonaRouting.ts";
import { providerCanEnforceAgentPersonaAuthority } from "./agentPersonaProviderPolicy.ts";
import {
  getBuiltInAgentPersona,
  type AgentAuthorityPolicyId,
  type AgentPersonaId,
} from "./agentPersonas.ts";

type AvailableAgentPersonaRoute = Extract<AgentPersonaRouteResolution, { status: "available" }>;

export type BuiltInAgentPersonaAssignmentResult =
  | {
      readonly status: "assigned";
      readonly assignment: OrchestrationV2AgentPersonaAssignment;
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

export function buildBuiltInAgentPersonaAssignment(input: {
  readonly resolution: AvailableAgentPersonaRoute;
  readonly authorityPolicy?: AgentAuthorityPolicyId;
}): BuiltInAgentPersonaAssignmentResult {
  const definition = getBuiltInAgentPersona(input.resolution.personaId);
  const authorityPolicy = input.authorityPolicy ?? definition.authority.defaultPolicy;
  if (!definition.authority.allowedPolicies.some((policy) => policy === authorityPolicy)) {
    return {
      status: "invalid-authority-policy",
      personaId: definition.id,
      requestedPolicy: authorityPolicy,
      allowedPolicies: definition.authority.allowedPolicies,
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
      authorityPolicy,
      resolvedRoute: input.resolution.route,
      resolvedDriver: ProviderDriverKind.make(input.resolution.driver),
      resolvedModelSelection: input.resolution.modelSelection,
    },
  };
}

export function validateBuiltInAgentPersonaAssignment(
  assignment: OrchestrationV2AgentPersonaAssignment,
): string | undefined {
  const definition = getBuiltInAgentPersona(assignment.personaId);
  const target = definition.modelRoute[assignment.resolvedRoute === "primary" ? 0 : 1];
  const optionId = target.driver === "codex" ? "reasoningEffort" : "effort";
  const selectedEffort = assignment.resolvedModelSelection.options?.find(
    (option) => option.id === optionId,
  )?.value;

  if (assignment.definitionVersion !== definition.version) {
    return "Agent persona assignment uses an unknown definition version.";
  }
  if (
    !definition.authority.allowedPolicies.some((policy) => policy === assignment.authorityPolicy)
  ) {
    return "Agent persona assignment uses an authority policy outside its definition.";
  }
  if (!providerCanEnforceAgentPersonaAuthority(target.driver, assignment.authorityPolicy)) {
    return "Agent persona assignment targets a provider that cannot enforce its authority policy.";
  }
  if (
    assignment.resolvedDriver !== target.driver ||
    assignment.resolvedModelSelection.model !== target.model ||
    selectedEffort !== target.reasoningEffort
  ) {
    return "Agent persona assignment does not match its declared model route.";
  }
  return undefined;
}

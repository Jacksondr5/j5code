import { type OrchestrationV2AgentPersonaAssignment, ProviderDriverKind } from "@t3tools/contracts";

import type { AgentPersonaRouteResolution } from "./agentPersonaRouting.ts";
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

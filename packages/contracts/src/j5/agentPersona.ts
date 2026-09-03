import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";
import { ProviderDriverKind } from "../providerInstance.ts";

/**
 * J5-owned agent persona wire schemas. Upstream orchestration structs reference only
 * `OrchestrationV2AgentPersonaAssignment` and `OrchestrationV2AgentPersonaRequest`
 * through additive-optional fields; everything else stays here.
 */
export const BUILT_IN_AGENT_PERSONA_IDS = [
  "scout",
  "navigator",
  "advocate",
  "skeptic",
  "builder",
  "critic",
  "sentry",
  "publisher",
  "investigator",
  "prosecutor",
  "herald",
] as const;

export const BuiltInAgentPersonaId = Schema.Literals(BUILT_IN_AGENT_PERSONA_IDS);
export type BuiltInAgentPersonaId = typeof BuiltInAgentPersonaId.Type;

export const AgentPersonaAuthorityPolicy = Schema.Literals([
  "read-only",
  "workspace-write",
  "critic-review",
  "critic-fix",
  "diagnostic",
  "publish-only",
]);
export type AgentPersonaAuthorityPolicy = typeof AgentPersonaAuthorityPolicy.Type;

export const BUILT_IN_AGENT_ARTIFACT_IDS = [
  "ContextBrief",
  "PlanHandoff",
  "PlanCritique",
  "CodeCompleteHandoff",
  "ReviewHandoff",
  "PublicationReceipt",
  "DiagnosisHandoff",
  "DiagnosisCritique",
  "ReviewInbox",
] as const;

export const BuiltInAgentArtifactId = Schema.Literals(BUILT_IN_AGENT_ARTIFACT_IDS);
export type BuiltInAgentArtifactId = typeof BuiltInAgentArtifactId.Type;

export const OrchestrationV2AgentPersonaRequest = Schema.Struct({
  personaId: BuiltInAgentPersonaId,
  authorityPolicy: Schema.optional(AgentPersonaAuthorityPolicy),
});
export type OrchestrationV2AgentPersonaRequest = typeof OrchestrationV2AgentPersonaRequest.Type;

/** Immutable launch-time provenance for a thread assigned to a built-in persona. */
export const OrchestrationV2AgentPersonaAssignment = Schema.Struct({
  personaId: BuiltInAgentPersonaId,
  definitionVersion: PositiveInt,
  authorityPolicy: AgentPersonaAuthorityPolicy,
  resolvedRoute: Schema.Literals(["primary", "fallback"]),
  resolvedDriver: ProviderDriverKind,
  resolvedModelSelection: ModelSelection,
});
export type OrchestrationV2AgentPersonaAssignment =
  typeof OrchestrationV2AgentPersonaAssignment.Type;

export const OrchestrationV2AgentPersonaAvailability = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    resolvedRoute: Schema.Literals(["primary", "fallback"]),
    resolvedDriver: ProviderDriverKind,
    resolvedModelSelection: ModelSelection,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["routes-unavailable", "authority-not-enforceable"]),
  }),
]);
export type OrchestrationV2AgentPersonaAvailability =
  typeof OrchestrationV2AgentPersonaAvailability.Type;

/** Environment-specific, presentation-safe view of one built-in persona. */
export const OrchestrationV2AgentPersonaCatalogEntry = Schema.Struct({
  personaId: BuiltInAgentPersonaId,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  acceptedInput: TrimmedNonEmptyString,
  outputArtifact: BuiltInAgentArtifactId,
  defaultAuthorityPolicy: AgentPersonaAuthorityPolicy,
  allowedAuthorityPolicies: Schema.Array(AgentPersonaAuthorityPolicy),
  availability: OrchestrationV2AgentPersonaAvailability,
});
export type OrchestrationV2AgentPersonaCatalogEntry =
  typeof OrchestrationV2AgentPersonaCatalogEntry.Type;

export const OrchestrationV2AgentPersonaCatalog = Schema.Struct({
  personas: Schema.Array(OrchestrationV2AgentPersonaCatalogEntry),
});
export type OrchestrationV2AgentPersonaCatalog = typeof OrchestrationV2AgentPersonaCatalog.Type;

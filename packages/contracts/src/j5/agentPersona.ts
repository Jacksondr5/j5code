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

export const AgentPersonaId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
);
export type AgentPersonaId = typeof AgentPersonaId.Type;

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
  personaId: AgentPersonaId,
  authorityPolicy: Schema.optional(AgentPersonaAuthorityPolicy),
});
export type OrchestrationV2AgentPersonaRequest = typeof OrchestrationV2AgentPersonaRequest.Type;

/** Immutable launch-time provenance; definitionDigest references an environment-owned snapshot. */
export const OrchestrationV2AgentPersonaAssignment = Schema.Struct({
  personaId: AgentPersonaId,
  definitionVersion: PositiveInt,
  definitionDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  displayName: Schema.optional(TrimmedNonEmptyString),
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
    reason: Schema.Literals(["routes-unavailable", "authority-not-enforceable", "disabled"]),
  }),
]);
export type OrchestrationV2AgentPersonaAvailability =
  typeof OrchestrationV2AgentPersonaAvailability.Type;

export const AgentPersonaModelTarget = Schema.Struct({
  driver: Schema.Literals(["codex", "claudeAgent"]),
  model: TrimmedNonEmptyString,
  reasoningEffort: TrimmedNonEmptyString,
});
export type AgentPersonaModelTarget = typeof AgentPersonaModelTarget.Type;
export const AgentPersonaEditableDetails = Schema.Struct({
  definitionDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  modelRoute: Schema.Tuple([AgentPersonaModelTarget, AgentPersonaModelTarget]),
});
export const AgentPersonaEditInput = Schema.Struct({
  personaId: AgentPersonaId,
  expectedDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  authorityPolicy: AgentPersonaAuthorityPolicy,
  modelRoute: Schema.Tuple([AgentPersonaModelTarget, AgentPersonaModelTarget]),
});
export type AgentPersonaEditInput = typeof AgentPersonaEditInput.Type;

/** Environment-specific, presentation-safe view of one library persona. */
export const OrchestrationV2AgentPersonaCatalogEntry = Schema.Struct({
  personaId: AgentPersonaId,
  imported: Schema.optional(Schema.Boolean),
  editable: Schema.optional(AgentPersonaEditableDetails),
  definitionVersion: PositiveInt,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  acceptedInput: TrimmedNonEmptyString,
  outputArtifact: TrimmedNonEmptyString,
  defaultAuthorityPolicy: AgentPersonaAuthorityPolicy,
  allowedAuthorityPolicies: Schema.Array(AgentPersonaAuthorityPolicy),
  availability: OrchestrationV2AgentPersonaAvailability,
});
export type OrchestrationV2AgentPersonaCatalogEntry =
  typeof OrchestrationV2AgentPersonaCatalogEntry.Type;

export class AgentPersonaCatalogError extends Schema.TaggedErrorClass<AgentPersonaCatalogError>()(
  "AgentPersonaCatalogError",
  { message: Schema.String },
) {}

export const OrchestrationV2AgentPersonaCatalog = Schema.Struct({
  personas: Schema.Array(OrchestrationV2AgentPersonaCatalogEntry),
});
export type OrchestrationV2AgentPersonaCatalog = typeof OrchestrationV2AgentPersonaCatalog.Type;

export const isAgentPersonaDefinitionFile = (name: string): boolean =>
  /\.(json|ya?ml)$/i.test(name);

export const AGENT_PERSONA_IMPORT_MAX_FILES = 50;
export const AGENT_PERSONA_IMPORT_MAX_BYTES = 65536;
export const AgentPersonaImportConflict = Schema.Struct({
  personaId: AgentPersonaId,
  displayName: TrimmedNonEmptyString,
  definitionDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AgentPersonaImportConflict = typeof AgentPersonaImportConflict.Type;
export class AgentPersonaImportConflictError extends Schema.TaggedErrorClass<AgentPersonaImportConflictError>()(
  "AgentPersonaImportConflictError",
  { message: Schema.String, conflicts: Schema.Array(AgentPersonaImportConflict) },
) {}

export const AgentPersonaImportInput = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
      content: Schema.String.check(Schema.isMaxLength(AGENT_PERSONA_IMPORT_MAX_BYTES)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(AGENT_PERSONA_IMPORT_MAX_FILES)),
  replaceExisting: Schema.Boolean,
  skippedPersonaIds: Schema.optional(
    Schema.Array(AgentPersonaId).check(Schema.isMaxLength(AGENT_PERSONA_IMPORT_MAX_FILES)),
  ),
  confirmedConflicts: Schema.optional(
    Schema.Array(AgentPersonaImportConflict).check(
      Schema.isMaxLength(AGENT_PERSONA_IMPORT_MAX_FILES),
    ),
  ),
});
export type AgentPersonaImportInput = typeof AgentPersonaImportInput.Type;

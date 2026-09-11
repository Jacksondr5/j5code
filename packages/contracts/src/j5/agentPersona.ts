import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "../auth.ts";
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
    reason: Schema.Literals([
      "routes-unavailable",
      "authority-not-enforceable",
      "disabled",
      "removed",
    ]),
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
export const AGENT_PERSONA_INSTRUCTIONS_MAX_LENGTH = 32768;
const AgentPersonaInstructions = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(AGENT_PERSONA_INSTRUCTIONS_MAX_LENGTH),
);
export const AgentPersonaEditInput = Schema.Struct({
  personaId: AgentPersonaId,
  expectedDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  instructions: AgentPersonaInstructions,
  authorityPolicy: AgentPersonaAuthorityPolicy,
  modelRoute: Schema.Tuple([AgentPersonaModelTarget, AgentPersonaModelTarget]),
});
export type AgentPersonaEditInput = typeof AgentPersonaEditInput.Type;

/** The full definition as stored; the catalog omits instructions to keep lists small. */
export const AgentPersonaDefinitionView = Schema.Struct({
  id: AgentPersonaId,
  version: PositiveInt,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  instructions: AgentPersonaInstructions,
  acceptedInput: Schema.optional(TrimmedNonEmptyString),
  artifacts: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  inputArtifacts: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  outputArtifact: Schema.optional(TrimmedNonEmptyString),
  authority: Schema.Struct({
    defaultPolicy: AgentPersonaAuthorityPolicy,
    allowedPolicies: Schema.Array(AgentPersonaAuthorityPolicy),
  }),
  modelRoute: Schema.Tuple([AgentPersonaModelTarget, AgentPersonaModelTarget]),
});
export type AgentPersonaDefinitionView = typeof AgentPersonaDefinitionView.Type;

/** A personal agent authored in Settings; the server fills the remaining definition fields. */
export const AgentPersonaCreateInput = Schema.Struct({
  id: AgentPersonaId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  instructions: AgentPersonaInstructions,
  authorityPolicy: AgentPersonaAuthorityPolicy,
  modelRoute: Schema.Tuple([AgentPersonaModelTarget, AgentPersonaModelTarget]),
});
export type AgentPersonaCreateInput = typeof AgentPersonaCreateInput.Type;

/** Environment-specific, presentation-safe view of one library persona. */
export const OrchestrationV2AgentPersonaCatalogEntry = Schema.Struct({
  personaId: AgentPersonaId,
  imported: Schema.optional(Schema.Boolean),
  /** A source or bundled definition the user removed; it stays listed so it can be restored. */
  removed: Schema.optional(Schema.Boolean),
  editable: Schema.optional(AgentPersonaEditableDetails),
  definitionVersion: PositiveInt,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  acceptedInput: Schema.optional(TrimmedNonEmptyString),
  outputArtifact: Schema.optional(TrimmedNonEmptyString),
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

/** User-authored definitions are YAML only; internal stores and snapshots stay JSON. */
export const isAgentPersonaDefinitionFile = (name: string): boolean => /\.ya?ml$/i.test(name);

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

// ---------------------------------------------------------------------------
// Library management RPCs. These ride the upstream WebSocket RPC transport via one
// `WsRpcGroup.merge(...)` call so environment scoping, remote connections, and
// mobile keep working without a second wire path, while every definition stays here.
// ---------------------------------------------------------------------------

export const J5_AGENT_PERSONA_WS_METHODS = {
  getAgentPersonaCatalog: "j5.agentPersonas.getCatalog",
  importAgentPersonas: "j5.agentPersonas.import",
  editImportedAgentPersona: "j5.agentPersonas.editImported",
  setImportedAgentPersonaEnabled: "j5.agentPersonas.setImportedEnabled",
  removeImportedAgentPersona: "j5.agentPersonas.removeImported",
  removeSourceAgentPersona: "j5.agentPersonas.removeSource",
  removeAgentPersona: "j5.agentPersonas.remove",
  restoreSourceAgentPersona: "j5.agentPersonas.restoreSource",
  createAgentPersona: "j5.agentPersonas.create",
  readAgentPersona: "j5.agentPersonas.read",
} as const;

export const J5AgentPersonaRpcSchemas = {
  getAgentPersonaCatalog: {
    input: Schema.Struct({}),
    output: OrchestrationV2AgentPersonaCatalog,
  },
  importAgentPersonas: {
    input: AgentPersonaImportInput,
    output: Schema.Struct({ importedIds: Schema.Array(AgentPersonaId) }),
  },
  editImportedAgentPersona: {
    input: AgentPersonaEditInput,
    output: Schema.Void,
  },
  setImportedAgentPersonaEnabled: {
    input: Schema.Struct({ personaId: AgentPersonaId, enabled: Schema.Boolean }),
    output: Schema.Void,
  },
  removeImportedAgentPersona: {
    input: Schema.Struct({ personaId: AgentPersonaId }),
    output: Schema.Void,
  },
  removeSourceAgentPersona: {
    input: Schema.Struct({ personaId: AgentPersonaId }),
    output: Schema.Void,
  },
  removeAgentPersona: {
    input: Schema.Struct({ personaId: AgentPersonaId }),
    output: Schema.Void,
  },
  restoreSourceAgentPersona: {
    input: Schema.Struct({ personaId: AgentPersonaId }),
    output: Schema.Void,
  },
  createAgentPersona: {
    input: AgentPersonaCreateInput,
    output: Schema.Struct({ personaId: AgentPersonaId }),
  },
  readAgentPersona: {
    input: Schema.Struct({ personaId: AgentPersonaId }),
    output: Schema.Struct({
      definition: AgentPersonaDefinitionView,
      fileName: TrimmedNonEmptyString,
      yaml: Schema.String,
    }),
  },
} as const;

const catalogErrors = Schema.Union([EnvironmentAuthorizationError, AgentPersonaCatalogError]);

export const WsJ5GetAgentPersonaCatalogRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog,
  {
    payload: J5AgentPersonaRpcSchemas.getAgentPersonaCatalog.input,
    success: J5AgentPersonaRpcSchemas.getAgentPersonaCatalog.output,
    error: catalogErrors,
  },
);
export const WsJ5ImportAgentPersonasRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.importAgentPersonas,
  {
    payload: J5AgentPersonaRpcSchemas.importAgentPersonas.input,
    success: J5AgentPersonaRpcSchemas.importAgentPersonas.output,
    error: Schema.Union([
      EnvironmentAuthorizationError,
      AgentPersonaCatalogError,
      AgentPersonaImportConflictError,
    ]),
  },
);
export const WsJ5EditImportedAgentPersonaRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.editImportedAgentPersona,
  {
    payload: J5AgentPersonaRpcSchemas.editImportedAgentPersona.input,
    success: J5AgentPersonaRpcSchemas.editImportedAgentPersona.output,
    error: catalogErrors,
  },
);
export const WsJ5SetImportedAgentPersonaEnabledRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.setImportedAgentPersonaEnabled,
  {
    payload: J5AgentPersonaRpcSchemas.setImportedAgentPersonaEnabled.input,
    success: J5AgentPersonaRpcSchemas.setImportedAgentPersonaEnabled.output,
    error: catalogErrors,
  },
);
export const WsJ5RemoveImportedAgentPersonaRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.removeImportedAgentPersona,
  {
    payload: J5AgentPersonaRpcSchemas.removeImportedAgentPersona.input,
    success: J5AgentPersonaRpcSchemas.removeImportedAgentPersona.output,
    error: catalogErrors,
  },
);
export const WsJ5RemoveSourceAgentPersonaRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.removeSourceAgentPersona,
  {
    payload: J5AgentPersonaRpcSchemas.removeSourceAgentPersona.input,
    success: J5AgentPersonaRpcSchemas.removeSourceAgentPersona.output,
    error: catalogErrors,
  },
);
export const WsJ5RemoveAgentPersonaRpc = Rpc.make(J5_AGENT_PERSONA_WS_METHODS.removeAgentPersona, {
  payload: J5AgentPersonaRpcSchemas.removeAgentPersona.input,
  success: J5AgentPersonaRpcSchemas.removeAgentPersona.output,
  error: catalogErrors,
});
export const WsJ5RestoreSourceAgentPersonaRpc = Rpc.make(
  J5_AGENT_PERSONA_WS_METHODS.restoreSourceAgentPersona,
  {
    payload: J5AgentPersonaRpcSchemas.restoreSourceAgentPersona.input,
    success: J5AgentPersonaRpcSchemas.restoreSourceAgentPersona.output,
    error: catalogErrors,
  },
);

export const WsJ5CreateAgentPersonaRpc = Rpc.make(J5_AGENT_PERSONA_WS_METHODS.createAgentPersona, {
  payload: J5AgentPersonaRpcSchemas.createAgentPersona.input,
  success: J5AgentPersonaRpcSchemas.createAgentPersona.output,
  error: catalogErrors,
});

export const WsJ5ReadAgentPersonaRpc = Rpc.make(J5_AGENT_PERSONA_WS_METHODS.readAgentPersona, {
  payload: J5AgentPersonaRpcSchemas.readAgentPersona.input,
  success: J5AgentPersonaRpcSchemas.readAgentPersona.output,
  error: catalogErrors,
});

/** Merged into `WsRpcGroup` by one appended call; no other upstream registration exists. */
export const J5AgentPersonaRpcGroup = RpcGroup.make(
  WsJ5GetAgentPersonaCatalogRpc,
  WsJ5ImportAgentPersonasRpc,
  WsJ5EditImportedAgentPersonaRpc,
  WsJ5SetImportedAgentPersonaEnabledRpc,
  WsJ5RemoveImportedAgentPersonaRpc,
  WsJ5RemoveSourceAgentPersonaRpc,
  WsJ5RemoveAgentPersonaRpc,
  WsJ5RestoreSourceAgentPersonaRpc,
  WsJ5CreateAgentPersonaRpc,
  WsJ5ReadAgentPersonaRpc,
);

import {
  BUILT_IN_AGENT_ARTIFACT_IDS,
  BUILT_IN_AGENT_PERSONA_IDS,
  AgentPersonaAuthorityPolicy,
  AgentPersonaId,
  AgentPersonaModelTarget,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const AGENT_PERSONA_IDS = BUILT_IN_AGENT_PERSONA_IDS;
export type { AgentPersonaId };
export type AgentArtifactId = string;
export type AgentAuthorityPolicyId = AgentPersonaAuthorityPolicy;

export interface AgentAuthorityRules {
  readonly workspace: "read-only" | "write" | "diagnostic-write" | "publication-only";
  readonly mayCommit: boolean;
  readonly mayPush: boolean;
  readonly mayWritePullRequest: boolean;
  readonly mayMergePullRequest: false;
}

/** Behavioral expectations; provider policy translation separately defines enforceable controls. */
export const AGENT_AUTHORITY_RULES = {
  "read-only": {
    workspace: "read-only",
    mayCommit: false,
    mayPush: false,
    mayWritePullRequest: false,
    mayMergePullRequest: false,
  },
  "workspace-write": {
    workspace: "write",
    mayCommit: false,
    mayPush: false,
    mayWritePullRequest: false,
    mayMergePullRequest: false,
  },
  "critic-review": {
    workspace: "read-only",
    mayCommit: false,
    mayPush: false,
    mayWritePullRequest: false,
    mayMergePullRequest: false,
  },
  "critic-fix": {
    workspace: "write",
    mayCommit: false,
    mayPush: false,
    mayWritePullRequest: false,
    mayMergePullRequest: false,
  },
  diagnostic: {
    workspace: "diagnostic-write",
    mayCommit: false,
    mayPush: false,
    mayWritePullRequest: false,
    mayMergePullRequest: false,
  },
  "publish-only": {
    workspace: "publication-only",
    mayCommit: true,
    mayPush: true,
    mayWritePullRequest: true,
    mayMergePullRequest: false,
  },
} as const satisfies Record<AgentAuthorityPolicyId, AgentAuthorityRules>;

const NonEmpty = TrimmedNonEmptyString;
const AgentModelTarget = AgentPersonaModelTarget;
export type AgentModelTarget = typeof AgentModelTarget.Type;

export const AgentPersonaDefinition = Schema.Struct({
  id: AgentPersonaId,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  displayName: NonEmpty,
  description: NonEmpty,
  acceptedInput: NonEmpty,
  artifacts: Schema.optional(Schema.Array(NonEmpty)),
  inputArtifacts: Schema.Array(NonEmpty),
  outputArtifact: NonEmpty,
  authority: Schema.Struct({
    defaultPolicy: AgentPersonaAuthorityPolicy,
    allowedPolicies: Schema.Array(AgentPersonaAuthorityPolicy),
  }),
  modelRoute: Schema.Tuple([AgentModelTarget, AgentModelTarget]),
  instructions: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32768)),
});
export type AgentPersonaDefinition = typeof AgentPersonaDefinition.Type;

const decodeDefinition = Schema.decodeUnknownSync(AgentPersonaDefinition);

export function decodeAgentPersonaDefinition(value: unknown): AgentPersonaDefinition {
  const definition = decodeDefinition(value);
  if (!definition.authority.allowedPolicies.includes(definition.authority.defaultPolicy)) {
    throw new Error(`Persona ${definition.id}: default authority must be allowed.`);
  }
  const artifacts = new Set<string>([
    ...BUILT_IN_AGENT_ARTIFACT_IDS,
    ...(definition.artifacts ?? []),
  ]);
  for (const artifact of [...definition.inputArtifacts, definition.outputArtifact]) {
    if (!artifacts.has(artifact))
      throw new Error(`Persona ${definition.id}: undefined artifact ${artifact}.`);
  }
  return definition;
}

export const getAgentAuthorityRules = (id: AgentAuthorityPolicyId): AgentAuthorityRules =>
  AGENT_AUTHORITY_RULES[id];

import {
  BUILT_IN_AGENT_ARTIFACT_IDS,
  BUILT_IN_AGENT_PERSONA_IDS,
  AgentPersonaAuthorityPolicy,
  AgentPersonaId,
  AgentPersonaModelTarget,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import scout from "./examples/scout.json" with { type: "json" };
import navigator from "./examples/navigator.json" with { type: "json" };
import advocate from "./examples/advocate.json" with { type: "json" };
import skeptic from "./examples/skeptic.json" with { type: "json" };
import builder from "./examples/builder.json" with { type: "json" };
import critic from "./examples/critic.json" with { type: "json" };
import sentry from "./examples/sentry.json" with { type: "json" };
import publisher from "./examples/publisher.json" with { type: "json" };
import investigator from "./examples/investigator.json" with { type: "json" };
import prosecutor from "./examples/prosecutor.json" with { type: "json" };
import herald from "./examples/herald.json" with { type: "json" };

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
  /** Handoff pipelines declare inputs and outputs; personal agents may leave them out. */
  acceptedInput: Schema.optional(NonEmpty),
  artifacts: Schema.optional(Schema.Array(NonEmpty)),
  inputArtifacts: Schema.optional(Schema.Array(NonEmpty)),
  outputArtifact: Schema.optional(NonEmpty),
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
  for (const artifact of [
    ...(definition.inputArtifacts ?? []),
    ...(definition.outputArtifact === undefined ? [] : [definition.outputArtifact]),
  ]) {
    if (!artifacts.has(artifact))
      throw new Error(`Persona ${definition.id}: undefined artifact ${artifact}.`);
  }
  return definition;
}

/** Bundled examples use exactly the same format and validation as imported definitions. */
export const BUILT_IN_AGENT_PERSONAS = {
  scout: decodeAgentPersonaDefinition(scout),
  navigator: decodeAgentPersonaDefinition(navigator),
  advocate: decodeAgentPersonaDefinition(advocate),
  skeptic: decodeAgentPersonaDefinition(skeptic),
  builder: decodeAgentPersonaDefinition(builder),
  critic: decodeAgentPersonaDefinition(critic),
  sentry: decodeAgentPersonaDefinition(sentry),
  publisher: decodeAgentPersonaDefinition(publisher),
  investigator: decodeAgentPersonaDefinition(investigator),
  prosecutor: decodeAgentPersonaDefinition(prosecutor),
  herald: decodeAgentPersonaDefinition(herald),
};

export const getBuiltInAgentPersona = (id: string): AgentPersonaDefinition => {
  const definition = listBuiltInAgentPersonas().find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown agent persona: ${id}.`);
  return definition;
};

export const getAgentAuthorityRules = (id: AgentAuthorityPolicyId): AgentAuthorityRules =>
  AGENT_AUTHORITY_RULES[id];

export const listBuiltInAgentPersonas = (): ReadonlyArray<AgentPersonaDefinition> =>
  Object.values(BUILT_IN_AGENT_PERSONAS);

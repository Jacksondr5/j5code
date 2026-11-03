import {
  BUILT_IN_AGENT_PERSONA_IDS,
  AgentPersonaAuthorityPolicy,
  AgentPersonaAccess,
  AgentPersonaModelEntry,
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

const NonEmpty = TrimmedNonEmptyString;
const AgentModelTarget = AgentPersonaModelTarget;
export type AgentModelTarget = typeof AgentModelTarget.Type;

export const AgentPersonaDefinition = Schema.Struct({
  id: AgentPersonaId,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  displayName: NonEmpty,
  description: NonEmpty,
  acceptedInput: Schema.optional(NonEmpty),
  // Retained only for stored-definition identity; their values never affect behavior.
  artifacts: Schema.optional(Schema.Unknown),
  inputArtifacts: Schema.optional(Schema.Unknown),
  outputArtifact: Schema.optional(Schema.Unknown),
  authority: Schema.optional(
    Schema.Struct({
      defaultPolicy: AgentPersonaAuthorityPolicy,
      allowedPolicies: Schema.Array(AgentPersonaAuthorityPolicy),
    }),
  ),
  access: Schema.optional(AgentPersonaAccess),
  modelRoute: Schema.NonEmptyArray(AgentPersonaModelEntry),
  instructions: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32768)),
});
export type AgentPersonaDefinition = typeof AgentPersonaDefinition.Type;

const LegacyAgentPersonaDefinition = Schema.Struct({
  ...AgentPersonaDefinition.fields,
  authority: Schema.Struct({
    defaultPolicy: AgentPersonaAuthorityPolicy,
    allowedPolicies: Schema.Array(AgentPersonaAuthorityPolicy),
  }),
  modelRoute: Schema.Tuple([AgentModelTarget, AgentModelTarget]),
});
const decodeLegacyExample = Schema.decodeUnknownSync(LegacyAgentPersonaDefinition);

const decodeDefinition = Schema.decodeUnknownSync(AgentPersonaDefinition);

export function decodeAgentPersonaDefinition(
  value: typeof LegacyAgentPersonaDefinition.Type,
): typeof LegacyAgentPersonaDefinition.Type;
export function decodeAgentPersonaDefinition(value: unknown): AgentPersonaDefinition;
export function decodeAgentPersonaDefinition(value: unknown): AgentPersonaDefinition {
  const definition = decodeDefinition(value);
  if ((definition.authority === undefined) === (definition.access === undefined)) {
    throw new Error("Specify either access or legacy authority, not both.");
  }
  if (
    definition.authority !== undefined &&
    !definition.authority.allowedPolicies.includes(definition.authority.defaultPolicy)
  ) {
    throw new Error(`Persona ${definition.id}: default authority must be allowed.`);
  }
  return definition;
}

export const mapAgentPersonaPolicy = (policy: AgentPersonaAuthorityPolicy) =>
  policy === "critic-review" ? "read-only" : policy === "critic-fix" ? "workspace-write" : policy;

export const agentPersonaPolicy = (definition: AgentPersonaDefinition) =>
  mapAgentPersonaPolicy(definition.access ?? definition.authority!.defaultPolicy);

export const agentPersonaAccess = (definition: AgentPersonaDefinition) => {
  const policy = agentPersonaPolicy(definition);
  return policy === "diagnostic" || policy === "publish-only" ? undefined : policy;
};

export const AGENT_PERSONA_ACCESS_REPAIR =
  "Choose read-only, workspace-write, or full-access instead of diagnostic or publish-only.";

export const agentPersonaLegacyEditable = (definition: AgentPersonaDefinition) =>
  definition.access === undefined &&
  definition.authority !== undefined &&
  definition.modelRoute.length === 2 &&
  definition.modelRoute.every((target) => "driver" in target);

/** Historical assignments retain their definitions even when their access cannot launch today. */
export const BUILT_IN_AGENT_PERSONAS = {
  scout: decodeLegacyExample(scout),
  navigator: decodeLegacyExample(navigator),
  advocate: decodeLegacyExample(advocate),
  skeptic: decodeLegacyExample(skeptic),
  builder: decodeLegacyExample(builder),
  critic: decodeLegacyExample(critic),
  sentry: decodeLegacyExample(sentry),
  publisher: decodeLegacyExample(publisher),
  investigator: decodeLegacyExample(investigator),
  prosecutor: decodeLegacyExample(prosecutor),
  herald: decodeLegacyExample(herald),
};

export const getBuiltInAgentPersona = (id: string) => {
  const definition = listBuiltInAgentPersonas().find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown agent persona: ${id}.`);
  return definition;
};

export const listBuiltInAgentPersonas = () => Object.values(BUILT_IN_AGENT_PERSONAS);

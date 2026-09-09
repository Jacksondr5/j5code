import {
  BUILT_IN_AGENT_PERSONA_IDS,
  type AgentPersonaAuthorityPolicy,
  type BuiltInAgentArtifactId,
  type BuiltInAgentPersonaId,
} from "@t3tools/contracts";

export const AGENT_PERSONA_IDS = BUILT_IN_AGENT_PERSONA_IDS;
export type AgentPersonaId = BuiltInAgentPersonaId;

export type AgentArtifactId = BuiltInAgentArtifactId;

export type AgentAuthorityPolicyId = AgentPersonaAuthorityPolicy;

export interface AgentAuthorityRules {
  readonly workspace: "read-only" | "write" | "diagnostic-write" | "publication-only";
  readonly mayCommit: boolean;
  readonly mayPush: boolean;
  readonly mayWritePullRequest: boolean;
  readonly mayMergePullRequest: false;
}

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

export interface AgentModelTarget {
  readonly driver: "codex" | "claudeAgent";
  readonly model: string;
  readonly reasoningEffort: "medium" | "high";
}

export interface AgentPersonaDefinition {
  readonly id: AgentPersonaId;
  readonly version: 1;
  readonly displayName: string;
  readonly description: string;
  readonly acceptedInput: string;
  readonly inputArtifacts: ReadonlyArray<AgentArtifactId>;
  readonly outputArtifact: AgentArtifactId;
  readonly authority: {
    readonly defaultPolicy: AgentAuthorityPolicyId;
    readonly allowedPolicies: ReadonlyArray<AgentAuthorityPolicyId>;
  };
  readonly modelRoute: readonly [AgentModelTarget, AgentModelTarget];
}

export const BUILT_IN_AGENT_PERSONAS = {
  scout: {
    id: "scout",
    version: 1,
    displayName: "Scout",
    description: "Collects cited evidence into a Context Brief. Read-only.",
    acceptedInput: "Evidence request or prompt",
    inputArtifacts: [],
    outputArtifact: "ContextBrief",
    authority: { defaultPolicy: "read-only", allowedPolicies: ["read-only"] },
    modelRoute: [
      { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
      { driver: "claudeAgent", model: "claude-opus-5", reasoningEffort: "high" },
    ],
  },
  navigator: {
    id: "navigator",
    version: 1,
    displayName: "Navigator",
    description: "Turns a Context Brief into an implementation plan. Read-only.",
    acceptedInput: "ContextBrief",
    inputArtifacts: ["ContextBrief"],
    outputArtifact: "PlanHandoff",
    authority: { defaultPolicy: "read-only", allowedPolicies: ["read-only"] },
    modelRoute: [
      { driver: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
      { driver: "claudeAgent", model: "claude-fable-5-1", reasoningEffort: "high" },
    ],
  },
  advocate: {
    id: "advocate",
    version: 1,
    displayName: "Advocate",
    description: "Checks a plan against product and design requirements.",
    acceptedInput: "PlanHandoff plus Jira, Confluence, or Figma evidence",
    inputArtifacts: ["PlanHandoff"],
    outputArtifact: "PlanCritique",
    authority: { defaultPolicy: "read-only", allowedPolicies: ["read-only"] },
    modelRoute: [
      { driver: "claudeAgent", model: "claude-sonnet-5", reasoningEffort: "high" },
      { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
    ],
  },
  skeptic: {
    id: "skeptic",
    version: 1,
    displayName: "Skeptic",
    description: "Stress-tests a plan for feasibility, risk, and hidden scope.",
    acceptedInput: "PlanHandoff plus repository evidence",
    inputArtifacts: ["PlanHandoff"],
    outputArtifact: "PlanCritique",
    authority: { defaultPolicy: "read-only", allowedPolicies: ["read-only"] },
    modelRoute: [
      { driver: "claudeAgent", model: "claude-opus-5", reasoningEffort: "high" },
      { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
    ],
  },
  builder: {
    id: "builder",
    version: 1,
    displayName: "Builder",
    description: "Implements an approved handoff. Never commits or pushes.",
    acceptedInput: "PlanHandoff, DiagnosisHandoff, or ReviewInbox",
    inputArtifacts: ["PlanHandoff", "DiagnosisHandoff", "ReviewInbox"],
    outputArtifact: "CodeCompleteHandoff",
    authority: { defaultPolicy: "workspace-write", allowedPolicies: ["workspace-write"] },
    modelRoute: [
      { driver: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
      { driver: "claudeAgent", model: "claude-opus-5", reasoningEffort: "high" },
    ],
  },
  critic: {
    id: "critic",
    version: 1,
    displayName: "Critic",
    description: "Reviews implementation; Fix Mode may apply targeted fixes.",
    acceptedInput: "CodeCompleteHandoff plus governing handoff and diff",
    inputArtifacts: ["CodeCompleteHandoff", "PlanHandoff", "DiagnosisHandoff", "ReviewInbox"],
    outputArtifact: "ReviewHandoff",
    authority: {
      defaultPolicy: "critic-review",
      allowedPolicies: ["critic-review", "critic-fix"],
    },
    modelRoute: [
      { driver: "claudeAgent", model: "claude-opus-5", reasoningEffort: "high" },
      { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
    ],
  },
  sentry: {
    id: "sentry",
    version: 1,
    displayName: "Sentry",
    description: "Reviews a diff for security, authorization, secrets, and PII risks.",
    acceptedInput: "CodeCompleteHandoff plus diff and relevant architecture",
    inputArtifacts: ["CodeCompleteHandoff"],
    outputArtifact: "ReviewHandoff",
    authority: { defaultPolicy: "read-only", allowedPolicies: ["read-only"] },
    modelRoute: [
      { driver: "claudeAgent", model: "claude-fable-5-1", reasoningEffort: "high" },
      { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
    ],
  },
  publisher: {
    id: "publisher",
    version: 1,
    displayName: "Publisher",
    description: "Commits, pushes, and opens or updates a PR. Never merges.",
    acceptedInput: "CodeCompleteHandoff plus resolved review findings",
    inputArtifacts: ["CodeCompleteHandoff", "ReviewHandoff"],
    outputArtifact: "PublicationReceipt",
    authority: { defaultPolicy: "publish-only", allowedPolicies: ["publish-only"] },
    modelRoute: [
      { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "medium" },
      { driver: "claudeAgent", model: "claude-sonnet-5", reasoningEffort: "medium" },
    ],
  },
  investigator: {
    id: "investigator",
    version: 1,
    displayName: "Investigator",
    description: "Reproduces and diagnoses bugs without landing a fix.",
    acceptedInput: "Bug report, Jira issue, or diagnostic prompt",
    inputArtifacts: [],
    outputArtifact: "DiagnosisHandoff",
    authority: { defaultPolicy: "diagnostic", allowedPolicies: ["diagnostic"] },
    modelRoute: [
      { driver: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
      { driver: "claudeAgent", model: "claude-fable-5-1", reasoningEffort: "high" },
    ],
  },
  prosecutor: {
    id: "prosecutor",
    version: 1,
    displayName: "Prosecutor",
    description: "Challenges a diagnosis, its evidence, and proposed repair.",
    acceptedInput: "DiagnosisHandoff plus available evidence",
    inputArtifacts: ["DiagnosisHandoff"],
    outputArtifact: "DiagnosisCritique",
    authority: { defaultPolicy: "read-only", allowedPolicies: ["read-only"] },
    modelRoute: [
      { driver: "claudeAgent", model: "claude-opus-5", reasoningEffort: "high" },
      { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
    ],
  },
  herald: {
    id: "herald",
    version: 1,
    displayName: "Herald",
    description: "Reads and classifies GitHub review feedback.",
    acceptedInput: "Pull request target and review state",
    inputArtifacts: [],
    outputArtifact: "ReviewInbox",
    authority: { defaultPolicy: "read-only", allowedPolicies: ["read-only"] },
    modelRoute: [
      { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
      { driver: "claudeAgent", model: "claude-sonnet-5", reasoningEffort: "high" },
    ],
  },
} as const satisfies Record<AgentPersonaId, AgentPersonaDefinition>;

export const getBuiltInAgentPersona = (id: AgentPersonaId): AgentPersonaDefinition =>
  BUILT_IN_AGENT_PERSONAS[id];

export const getAgentAuthorityRules = (id: AgentAuthorityPolicyId): AgentAuthorityRules =>
  AGENT_AUTHORITY_RULES[id];

export const listBuiltInAgentPersonas = (): ReadonlyArray<AgentPersonaDefinition> =>
  AGENT_PERSONA_IDS.map(getBuiltInAgentPersona);

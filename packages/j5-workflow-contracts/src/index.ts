import * as Schema from "effect/Schema";

export const RunStatus = Schema.Literals([
  "running",
  "waiting_approval",
  "blocked",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
]);
export const WorkflowFailureCategory = Schema.Literals([
  "action_failed",
  "action_deadline_expired",
  "invalid_action_output",
  "revision_budget_exhausted",
  "missing_gate_evidence",
  "definition_mismatch",
  "candidate_changed",
  "transition_unavailable",
  "unknown",
]);
export const Artifact = Schema.Struct({
  id: Schema.String,
  hash: Schema.String,
  content: Schema.Unknown,
  producer: Schema.String,
  phase: Schema.String,
  revision: Schema.Number,
  attempt: Schema.Number,
  governs: Schema.Array(Schema.String),
});
export type Artifact = typeof Artifact.Type;
export const Action = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  phase: Schema.String,
  revision: Schema.Number,
  task: Schema.String,
  attempt: Schema.Number,
  kind: Schema.Literals(["agent", "code"]),
  adapter: Schema.String,
  status: Schema.Literals(["pending", "claimed", "completed", "blocked", "cancelled"]),
  deadline: Schema.Number,
  input: Schema.Unknown,
  result: Schema.NullOr(Artifact),
  externalIdentity: Schema.optional(Schema.String),
});
export type Action = typeof Action.Type;
export const Gate = Schema.Struct({
  revision: Schema.Number,
  artifactHash: Schema.String,
  artifactIds: Schema.Array(Schema.String),
});
export const Decision = Schema.Struct({
  gateRevision: Schema.Number,
  artifactHash: Schema.String,
  decision: Schema.Literals(["approve", "request_changes", "cancel"]),
  feedback: Schema.String,
  actor: Schema.String,
});
export type Decision = typeof Decision.Type;
export const Run = Schema.Struct({
  id: Schema.String,
  definitionId: Schema.String,
  definitionVersion: Schema.Number,
  definitionHash: Schema.String,
  squadronId: Schema.String,
  projectId: Schema.String,
  repository: Schema.String,
  baseCommit: Schema.String,
  inputs: Schema.Unknown,
  execution: Schema.Unknown,
  phase: Schema.String,
  revision: Schema.Number,
  status: RunStatus,
  cause: Schema.NullOr(Schema.String),
  failureCategory: Schema.optional(Schema.NullOr(WorkflowFailureCategory)),
  relevantActionId: Schema.optional(Schema.NullOr(Schema.String)),
  recovery: Schema.NullOr(
    Schema.Literals(["retry", "restore_definition", "inspect_external_result"]),
  ),
  gate: Schema.NullOr(Gate),
  actions: Schema.Array(Action),
  artifacts: Schema.Array(Artifact),
  approvals: Schema.Array(Decision),
  visits: Schema.Record(Schema.String, Schema.Number),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
});
export type Run = typeof Run.Type;
export const RunSummary = Run.mapFields(
  ({
    actions: _actions,
    artifacts: _artifacts,
    approvals: _approvals,
    visits: _visits,
    inputs: _inputs,
    execution: _execution,
    ...fields
  }) => fields,
);
export type RunSummary = typeof RunSummary.Type;

export const WorkflowPhasePresentation = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["agent", "code", "gate"]),
  maxVisits: Schema.Number,
  transitions: Schema.Record(Schema.String, Schema.String),
});
export const WorkflowDefinitionPresentation = Schema.Struct({
  id: Schema.String,
  version: Schema.Number,
  hash: Schema.String,
  initial: Schema.String,
  phases: Schema.Array(WorkflowPhasePresentation),
});
export type WorkflowDefinitionPresentation = typeof WorkflowDefinitionPresentation.Type;

export const Mutation = Schema.Struct({
  commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  expectedRevision: Schema.Number,
});
export const StartRequest = Schema.Struct({
  ...Mutation.fields,
  definitionId: Schema.String,
  squadronId: Schema.String,
  baseRef: Schema.String,
  request: Schema.String.check(Schema.isMinLength(1)),
  evidence: Schema.Array(Schema.String),
});
export const GateRequest = Schema.Struct({
  ...Mutation.fields,
  gateRevision: Schema.Number,
  artifactHash: Schema.String,
  decision: Decision.fields.decision,
  feedback: Schema.String,
});
export const MetadataRequest = Schema.Struct({
  ...Mutation.fields,
  gateRevision: Schema.Number,
  artifactHash: Schema.String,
  commitMessage: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  body: Schema.String.check(Schema.isMaxLength(20000)),
});

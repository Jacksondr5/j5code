import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isMinLength(1));
export const VerificationCommand = Schema.Struct({
  executable: Text,
  args: Schema.Array(Schema.String),
});
export const ContextBrief = Schema.Struct({
  summary: Text,
  evidence: Schema.Array(Text),
  unknowns: Schema.Array(Text),
});
export const PlanHandoff = Schema.Struct({
  summary: Text,
  steps: Schema.Array(Text).check(Schema.isMinLength(1)),
  checks: Schema.Array(VerificationCommand).check(Schema.isMinLength(1)),
  assumptions: Schema.Array(Text),
});
export const CheckCorrection = Schema.Struct({
  originalIndex: Schema.Number,
  replacement: VerificationCommand,
  repositoryEvidence: Schema.Array(Text).check(Schema.isMinLength(1)),
  verificationIntent: Text,
});
export const VerificationDiagnosis = Schema.Struct({
  planHash: Text,
  failedValidationHash: Text,
  explanation: Text,
  outcome: Schema.Literals([
    "implementation_repair",
    "environment_repair",
    "check_correction",
    "unable_to_repair",
  ]),
  corrections: Schema.Array(CheckCorrection),
});
export const ReviewHandoff = Schema.Struct({
  verdict: Schema.Literals(["accept", "revise"]),
  subjectHash: Text,
  findings: Schema.Array(Schema.Struct({ blocking: Schema.Boolean, description: Text })),
});
export const CodeCompleteHandoff = Schema.Struct({ summary: Text, changes: Schema.Array(Text) });
export const Workspace = Schema.Struct({ worktree: Text, branch: Text, baseCommit: Text });
export const Validation = Schema.Struct({
  codeIdentity: Text,
  tree: Text,
  passed: Schema.Boolean,
  effectiveChecksHash: Text,
  correctionApproval: Schema.NullOr(
    Schema.Struct({ gateRevision: Schema.Number, artifactHash: Text, actor: Text }),
  ),
  checks: Schema.Array(
    Schema.Struct({
      executable: Text,
      args: Schema.Array(Schema.String),
      exitCode: Schema.Number,
      output: Schema.String,
    }),
  ),
});
export const Publication = Schema.Struct({
  diff: Schema.String,
  codeIdentity: Text,
  tree: Text,
  repository: Text,
  baseBranch: Text,
  headBranch: Text,
  commitMessage: Text,
  title: Text,
  body: Text,
  effectiveChecksHash: Text,
  correctionApproval: Schema.NullOr(
    Schema.Struct({ gateRevision: Schema.Number, artifactHash: Text, actor: Text }),
  ),
});
export const CommitResult = Schema.Struct({ commit: Text, codeIdentity: Text });
export const PushResult = Schema.Struct({ commit: Text, remoteSha: Text });
export const PullRequestResult = Schema.Struct({
  commit: Text,
  url: Text,
  number: Schema.Number,
  draft: Schema.Literal(true),
  merged: Schema.Literal(false),
});

import { readWorkflowExecution } from "../../workflow/Execution.ts";
import { definitionHash } from "../manifest.ts";
import type { Action, Artifact, Run } from "@j5/workflow-contracts";
import * as Handoff from "@j5/workflow-contracts/fh";
import * as Schema from "effect/Schema";
import {
  canonical,
  gateHash,
  hash,
  type Definition,
  type Phase,
} from "../../workflow/Definition.ts";

const decodePublication = Schema.decodeUnknownSync(Handoff.Publication);
const decodePlanHandoff = Schema.decodeUnknownSync(Handoff.PlanHandoff);
const decodeReviewHandoff = Schema.decodeUnknownSync(Handoff.ReviewHandoff);
const decodeValidation = Schema.decodeUnknownSync(Handoff.Validation);
const decodeVerificationDiagnosis = Schema.decodeUnknownSync(Handoff.VerificationDiagnosis);
const decodeWorkspace = Schema.decodeUnknownSync(Handoff.Workspace);

export const INSTRUCTIONS_VERSION = 4;
const instructions = {
  scout:
    "Inspect the repository and supplied evidence from the workflow worktree root, which is also where validation executes. Cite concrete paths. Record relevant test configuration, package scripts, project runtime selection, and dependency setup. Separate confirmed facts from unknowns. Return {summary,evidence:string[],unknowns:string[]}.",
  navigator:
    "Produce a minimal implementation plan addressing the request and review feedback. Validation executes from the workflow worktree root. Derive every verification command from Scout repository evidence and verify paths, configuration selection, and project names. Package-specific commands must select their directory or configuration explicitly. Resolve unspecified product choices using the simplest option consistent with the request and supplied evidence. Record each choice in assumptions and never ask the user for clarification. Record required verification as executable/argument arrays, without shell expansion or a working-directory field. Return {summary,steps:string[],checks:{executable,args:string[]}[],assumptions:string[]}.",
  advocate:
    "Review the latest plan for request completeness, user behavior, and supplied evidence. Validation executes from the workflow worktree root: verify command paths, explicit package/configuration selection, and project names against Scout evidence. Findings are blocking only when the plan contradicts the request or supplied evidence, is infeasible, or lacks executable verification. Reasonable assumptions resolving unspecified product choices are non-blocking, but recording a choice as an assumption does not exempt it from the blocking criteria. Record preference disagreements as non-blocking findings for human consideration at plan approval. Never require user clarification or prior human approval. Return revise if and only if at least one finding is blocking; otherwise return accept, including when non-blocking findings exist. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied plan hash.",
  skeptic:
    "Review the latest plan for feasibility, hidden assumptions, failure modes, and sufficient executable verification. Validation executes from the workflow worktree root: verify command paths, explicit package/configuration selection, and project names against Scout evidence. Findings are blocking only when the plan contradicts the request or supplied evidence, is infeasible, or lacks executable verification. Reasonable assumptions resolving unspecified product choices are non-blocking, but recording a choice as an assumption does not exempt it from the blocking criteria. Record preference disagreements as non-blocking findings for human consideration at plan approval. Never require user clarification or prior human approval. Return revise if and only if at least one finding is blocking; otherwise return accept, including when non-blocking findings exist. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied plan hash.",
  builder:
    "Implement only the latest approved plan in this workspace. Validation and your verification commands execute from the workflow worktree root. Prepare dependencies using the repository setup instructions, including workspace tooling packages such as lint plugins; sharing only root node_modules may be insufficient. Use the repository-selected runtime. Run the exact approved executable/argument arrays when reporting verification results. A modified command that passes is evidence for a check-correction proposal, never a successful approved check. Address review feedback and diagnosed implementation or environment failures. Never alter repository test configuration merely to make an incorrect command succeed. Never commit, push, or create a PR. Return {summary,changes:string[]}.",
  verification_diagnosis:
    "Act as the Skeptic. Inspect the failed validation and repository evidence from the workflow worktree root without modifying files. Classify the failure as implementation_repair, environment_repair, check_correction, or unable_to_repair. For a check correction, preserve verification intent and propose only exact replacement executable/argument arrays backed by repository evidence. Identify each failed original check by its zero-based index. Never delete checks, suppress errors, change their order, or propose repository configuration changes to accommodate a bad command. Only one correction can be approved and only two proposal versions may be recorded; if that capacity is spent, return unable_to_repair with the concrete reason and no corrections. Return {planHash,failedValidationHash,explanation,outcome,corrections:{originalIndex,replacement:{executable,args},repositoryEvidence:string[],verificationIntent}[]}.",
  critic:
    "Review the complete candidate changes against the approved plan and recorded validation. Validation executes from the workflow worktree root; confirm the recorded commands exactly match the approved effective checks, including any approved correction and its provenance. Do not modify files. Return revise if and only if at least one finding is blocking; otherwise return accept, including when non-blocking findings exist. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied codeIdentity.",
  sentry:
    "Review candidate changes for security, reliability, data loss, and regression risks. Validation executes from the workflow worktree root; confirm the recorded commands exactly match the approved effective checks, including any approved correction and its provenance. Do not modify files. Return revise if and only if at least one finding is blocking; otherwise return accept, including when non-blocking findings exist. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied codeIdentity.",
} as const;

const PLAN_BUDGET = 3;

export const latest = (run: Run, phase: string): Artifact => {
  const artifact = run.artifacts.findLast((item) => item.phase === phase);
  if (!artifact) throw new Error(`Missing ${phase} artifact`);
  return artifact;
};

const developmentInputs = Schema.decodeUnknownSync(
  Schema.Struct({
    request: Schema.String,
    baseRef: Schema.String,
    evidence: Schema.Array(Schema.String),
  }),
);
const artifactsIn = (run: Run, phase: string) =>
  run.artifacts.filter((artifact) => artifact.phase === phase);
const lastIn = (run: Run, phase: string) => artifactsIn(run, phase).at(-1);
const matchingReviews = (run: Run, phase: "plan_review" | "code_review", subject: string) =>
  artifactsIn(run, phase).filter(
    (artifact) => decodeReviewHandoff(artifact.content).subjectHash === subject,
  );
const decisionsIn = (
  run: Run,
  phase: "plan_approval" | "checks_approval" | "publication_approval",
) => run.approvals.filter((decision) => decision.phase === phase);
const uniqueArtifacts = (artifacts: ReadonlyArray<Artifact | undefined>) =>
  artifacts.filter(
    (artifact, index, all): artifact is Artifact =>
      artifact !== undefined &&
      all.findIndex((candidate) => candidate?.id === artifact.id) === index,
  );

export function selectAgentEvidence(run: Run, personaId: keyof typeof instructions) {
  const workspace = latest(run, "workspace");
  const context = lastIn(run, "scout");
  const plan = lastIn(run, "plan");
  const build = lastIn(run, "build");
  const validation = lastIn(run, "validation");
  const diagnosis = lastIn(run, "verification_diagnosis");
  const planChanges = decisionsIn(run, "plan_approval").filter(
    (decision) => decision.decision === "request_changes",
  );
  const publicationChanges = decisionsIn(run, "publication_approval").filter(
    (decision) => decision.decision === "request_changes",
  );
  let artifacts: ReadonlyArray<Artifact | undefined> = [workspace];
  let decisions = [] as ReadonlyArray<(typeof run.approvals)[number]>;
  switch (personaId) {
    case "scout":
      break;
    case "navigator":
      artifacts = [
        workspace,
        context,
        plan,
        ...(plan ? matchingReviews(run, "plan_review", plan.hash) : []),
      ];
      decisions = planChanges;
      break;
    case "advocate":
    case "skeptic":
      artifacts = [workspace, context, plan];
      decisions = planChanges;
      break;
    case "builder":
      artifacts = [
        workspace,
        context,
        plan,
        build,
        validation,
        diagnosis,
        ...(validation
          ? matchingReviews(run, "code_review", decodeValidation(validation.content).codeIdentity)
          : []),
      ];
      decisions = [
        ...decisionsIn(run, "plan_approval").filter((decision) => decision.decision === "approve"),
        ...decisionsIn(run, "checks_approval").filter(
          (decision) => decision.decision === "approve",
        ),
        ...publicationChanges,
      ];
      break;
    case "verification_diagnosis":
      artifacts = [workspace, context, plan, validation, diagnosis];
      decisions = decisionsIn(run, "checks_approval").filter(
        (decision) => decision.decision === "request_changes",
      );
      break;
    case "critic":
    case "sentry":
      artifacts = [workspace, context, plan, build, validation];
      decisions = publicationChanges;
      break;
  }
  return { artifacts: uniqueArtifacts(artifacts), decisions };
}

export const approvedCheckCorrection = (run: Run) => {
  for (const approval of decisionsIn(run, "checks_approval").filter(
    (decision) => decision.decision === "approve",
  )) {
    for (const diagnosis of artifactsIn(run, "verification_diagnosis")) {
      const content = decodeVerificationDiagnosis(diagnosis.content);
      if (content.outcome !== "check_correction") continue;
      const failed = artifactsIn(run, "validation").find(
        (artifact) => artifact.hash === content.failedValidationHash,
      );
      if (!failed) continue;
      const plan = latest(run, "plan");
      if (approval.artifactHash === gateHash([plan, failed, diagnosis])) {
        return { approval, diagnosis, failed, content };
      }
    }
  }
  return undefined;
};

export const effectiveChecks = (run: Run) => {
  const checks = [...decodePlanHandoff(latest(run, "plan").content).checks];
  const correction = approvedCheckCorrection(run);
  for (const item of correction?.content.corrections ?? [])
    checks[item.originalIndex] = item.replacement;
  return { checks, correction };
};

const codeEvidence = (run: Run, task: string) => {
  const planApproval = decisionsIn(run, "plan_approval").findLast(
    (decision) => decision.decision === "approve",
  );
  const publicationApproval = decisionsIn(run, "publication_approval").findLast(
    (decision) => decision.decision === "approve",
  );
  const correction = approvedCheckCorrection(run);
  switch (task) {
    case "workspace":
      return { artifacts: [], decisions: [] };
    case "validation":
      return {
        artifacts: uniqueArtifacts([
          lastIn(run, "plan"),
          correction?.failed,
          correction?.diagnosis,
        ]),
        decisions: [planApproval, correction?.approval],
      };
    case "repair_capacity":
    case "verification_block":
      return {
        artifacts: uniqueArtifacts([
          lastIn(run, "plan"),
          lastIn(run, "validation"),
          lastIn(run, "verification_diagnosis"),
        ]),
        decisions: [],
      };
    case "metadata":
      return {
        artifacts: uniqueArtifacts([lastIn(run, "build"), lastIn(run, "validation")]),
        decisions: [],
      };
    case "commit":
      return {
        artifacts: uniqueArtifacts([lastIn(run, "metadata")]),
        decisions: [publicationApproval],
      };
    case "push":
      return {
        artifacts: uniqueArtifacts([lastIn(run, "metadata"), lastIn(run, "commit")]),
        decisions: [publicationApproval],
      };
    case "draft":
      return {
        artifacts: uniqueArtifacts([lastIn(run, "metadata"), lastIn(run, "push")]),
        decisions: [publicationApproval],
      };
    default:
      return { artifacts: [], decisions: [] };
  }
};
const taskPhase = (
  id: string,
  kind: "agent" | "code",
  tasks: string[],
  transitions: Record<string, string>,
  maxVisits = 1,
): Phase => ({
  id,
  kind,
  tasks: tasks.map((task) => ({ id: task, adapter: kind === "agent" ? "persona" : task })),
  transitions,
  maxVisits,
});
const phases: Phase[] = [
  taskPhase("workspace", "code", ["workspace"], { pass: "scout" }),
  taskPhase("scout", "agent", ["scout"], { pass: "plan" }),
  taskPhase("plan", "agent", ["navigator"], { pass: "plan_review" }, PLAN_BUDGET),
  taskPhase(
    "plan_review",
    "agent",
    ["advocate", "skeptic"],
    { pass: "plan_approval", revise: "plan", escalate: "plan_approval" },
    PLAN_BUDGET,
  ),
  {
    id: "plan_approval",
    kind: "gate",
    tasks: [],
    transitions: { approve: "build", request_changes: "plan" },
    maxVisits: 3,
  },
  taskPhase("build", "agent", ["builder"], { pass: "validation" }, 3),
  taskPhase(
    "validation",
    "code",
    ["validation"],
    { pass: "code_review", revise: "verification_diagnosis" },
    4,
  ),
  taskPhase(
    "verification_diagnosis",
    "agent",
    ["verification_diagnosis"],
    {
      implementation_repair: "repair_capacity",
      environment_repair: "repair_capacity",
      check_correction: "checks_approval",
      unable_to_repair: "verification_block",
    },
    5,
  ),
  taskPhase("repair_capacity", "code", ["repair_capacity"], { pass: "build" }, 4),
  {
    id: "checks_approval",
    kind: "gate",
    tasks: [],
    transitions: { approve: "validation", request_changes: "verification_diagnosis" },
    maxVisits: 2,
  },
  taskPhase("verification_block", "code", ["verification_block"], {}, 4),
  taskPhase(
    "code_review",
    "agent",
    ["critic", "sentry"],
    { pass: "metadata", revise: "build", changed: "validation" },
    3,
  ),
  taskPhase("metadata", "code", ["metadata"], { pass: "publication_approval" }, 3),
  {
    id: "publication_approval",
    kind: "gate",
    tasks: [],
    transitions: { approve: "commit", request_changes: "build", changed: "validation" },
    maxVisits: 3,
  },
  taskPhase("commit", "code", ["commit"], { pass: "push" }),
  taskPhase("push", "code", ["push"], { pass: "draft" }),
  taskPhase("draft", "code", ["draft"], { pass: "$complete" }),
];

const outputSchemas = {
  workspace: Handoff.Workspace,
  scout: Handoff.ContextBrief,
  navigator: Handoff.PlanHandoff,
  advocate: Handoff.ReviewHandoff,
  skeptic: Handoff.ReviewHandoff,
  builder: Handoff.CodeCompleteHandoff,
  validation: Handoff.Validation,
  verification_diagnosis: Handoff.VerificationDiagnosis,
  repair_capacity: Schema.Struct({ ready: Schema.Literal(true) }),
  critic: Handoff.ReviewHandoff,
  sentry: Handoff.ReviewHandoff,
  metadata: Handoff.Publication,
  commit: Handoff.CommitResult,
  push: Handoff.PushResult,
  draft: Handoff.PullRequestResult,
};
function validate(action: Action, output: unknown, run: Run): unknown {
  if (canonical(output).length > 131072) throw new Error("Handoff exceeds 128 KiB");
  const schema = outputSchemas[action.task as keyof typeof outputSchemas];
  if (!schema) throw new Error(`No output schema for ${action.task}`);
  const content = Schema.decodeUnknownSync(schema)(output);
  if (action.task === "verification_diagnosis") {
    const diagnosis = decodeVerificationDiagnosis(content);
    const plan = latest(run, "plan");
    const failed = latest(run, "validation");
    const validation = decodeValidation(failed.content);
    if (validation.passed) throw new Error("Diagnosis requires a failed validation");
    if (diagnosis.planHash !== plan.hash || diagnosis.failedValidationHash !== failed.hash)
      throw new Error("Diagnosis refers to superseded plan or validation evidence");
    if (diagnosis.outcome !== "check_correction") {
      if (diagnosis.corrections.length)
        throw new Error("Only check corrections may replace checks");
      return content;
    }
    if (approvedCheckCorrection(run)) throw new Error("Only one approved correction is permitted");
    if (
      artifactsIn(run, "verification_diagnosis").filter(
        (artifact) => decodeVerificationDiagnosis(artifact.content).outcome === "check_correction",
      ).length >= 2
    )
      throw new Error("The two-version correction proposal limit is exhausted");
    if (!diagnosis.corrections.length) throw new Error("A check correction needs replacements");
    const planChecks = decodePlanHandoff(plan.content).checks;
    if (
      validation.effectiveChecksHash !== hash(planChecks) ||
      validation.checks.length !== planChecks.length ||
      validation.checks.some(
        (result, index) =>
          canonical({ executable: result.executable, args: result.args }) !==
          canonical(planChecks[index]),
      )
    )
      throw new Error("Failed validation does not match the approved plan checks");
    const indices = diagnosis.corrections.map((correction) => correction.originalIndex);
    if (
      indices.some((index) => !Number.isInteger(index) || index < 0 || index >= planChecks.length)
    )
      throw new Error("Correction refers to an invalid check index");
    if (new Set(indices).size !== indices.length)
      throw new Error("Correction contains duplicate check indices");
    for (const correction of diagnosis.corrections) {
      const original = planChecks[correction.originalIndex]!;
      const result = validation.checks[correction.originalIndex];
      if (!result || result.exitCode === 0)
        throw new Error("Correction may target only checks that failed");
      if (canonical(original) === canonical(correction.replacement))
        throw new Error("Correction replacement must change the command");
    }
  }
  if (["advocate", "skeptic", "critic", "sentry"].includes(action.task)) {
    const review = decodeReviewHandoff(content);
    const expected =
      action.phase === "plan_review"
        ? latest(run, "plan").hash
        : decodeValidation(latest(run, "validation").content).codeIdentity;
    if (review.subjectHash !== expected) throw new Error("Review refers to a superseded artifact");
    const hasBlocking = review.findings.some((finding) => finding.blocking);
    if ((review.verdict === "revise") !== hasBlocking) {
      throw new Error("Review verdict must match blocking findings");
    }
  }
  return content;
}

const decodeMetadataFields = Schema.decodeUnknownSync(
  Schema.Struct({
    commitMessage: Schema.String.check(Schema.isMinLength(1)),
    title: Schema.String.check(Schema.isMinLength(1)),
    body: Schema.String,
  }),
);

const definition: Omit<Definition, "hash"> = {
  id: "fh-development",
  version: 3,
  initial: "workspace",
  phases,
  validate,
  editGate: (run, content) => {
    if (run.phase !== "publication_approval")
      throw new Error("Only publication metadata is editable");
    const fields = decodeMetadataFields(content);
    const artifact = latest(run, "metadata");
    return { artifact, content: { ...decodePublication(artifact.content), ...fields } };
  },
  input: (run, phase, task) => {
    if (phase.kind !== "agent") {
      const selected = codeEvidence(run, task.id);
      const decisions = selected.decisions.filter(
        (decision): decision is NonNullable<typeof decision> => decision !== undefined,
      );
      return {
        inputs: run.inputs,
        selectedEvidenceIds: [
          ...selected.artifacts.map((artifact) => artifact.id),
          ...decisions.map((decision) => `decision:${hash(decision)}`),
        ],
        selectedEvidenceHashes: [
          ...selected.artifacts.map((artifact) => artifact.hash),
          ...decisions.map(hash),
        ],
      };
    }
    const workspace = decodeWorkspace(latest(run, "workspace").content);
    const instructionId = task.id as keyof typeof instructions;
    const personaId = instructionId === "verification_diagnosis" ? "skeptic" : instructionId;
    const inputs = developmentInputs(run.inputs);
    const selected = selectAgentEvidence(run, instructionId);
    const selectedEvidenceIds = [
      ...selected.artifacts.map((artifact) => artifact.id),
      ...selected.decisions.map((decision) => `decision:${hash(decision)}`),
    ];
    const selectedEvidenceHashes = [
      ...selected.artifacts.map((artifact) => artifact.hash),
      ...selected.decisions.map(hash),
    ];
    return {
      personaId,
      assignmentDigest: readWorkflowExecution(run.execution).personas[personaId].definitionDigest,
      worktree: workspace.worktree,
      branch: workspace.branch,
      selectedEvidenceIds,
      selectedEvidenceHashes,
      prompt: `Workflow operating instructions v${INSTRUCTIONS_VERSION}. ${instructions[instructionId]}\nReturn ONLY one JSON object. Do not invoke other agents or change Git history.\n${canonical(
        {
          request: inputs.request,
          suppliedEvidence: inputs.evidence,
          baseCommit: run.baseCommit,
          workspace: {
            repository: run.repository,
            projectId: run.projectId,
            squadronId: run.squadronId,
            ...workspace,
          },
          artifacts: selected.artifacts,
          decisions: selected.decisions,
        },
      )}`,
    };
  },
  outcome: (run, phase, artifacts) => {
    if (["plan_review", "code_review"].includes(phase.id)) {
      const accepted = artifacts.every((artifact) => {
        const review = decodeReviewHandoff(artifact.content);
        return review.verdict === "accept" && !review.findings.some((finding) => finding.blocking);
      });
      if (accepted) return "pass";
      if (
        phase.id === "plan_review" &&
        ((run.visits.plan ?? 0) >= PLAN_BUDGET || (run.visits.plan_review ?? 0) >= PLAN_BUDGET)
      ) {
        return "escalate";
      }
      return "revise";
    }
    if (phase.id === "validation")
      return decodeValidation(artifacts[0]!.content).passed ? "pass" : "revise";
    if (phase.id === "verification_diagnosis")
      return decodeVerificationDiagnosis(artifacts[0]!.content).outcome;
    return "pass";
  },
  gateArtifacts: (run, phase) => {
    if (phase.id === "checks_approval") {
      const diagnosis = latest(run, "verification_diagnosis");
      const content = decodeVerificationDiagnosis(diagnosis.content);
      const failed = artifactsIn(run, "validation").find(
        (artifact) => artifact.hash === content.failedValidationHash,
      );
      if (!failed) throw new Error("Referenced failed validation evidence is missing");
      return [latest(run, "plan"), failed, diagnosis];
    }
    const reviewPhase = phase.id === "plan_approval" ? "plan_review" : "code_review";
    const subject = latest(run, phase.id === "plan_approval" ? "plan" : "metadata");
    const reviews = matchingReviews(
      run,
      reviewPhase,
      phase.id === "plan_approval"
        ? subject.hash
        : decodeValidation(latest(run, "validation").content).codeIdentity,
    ).slice(-2);
    if (reviews.length !== 2) throw new Error("Both required reviewers must provide evidence");
    return [subject, ...reviews];
  },
};

export const development: Definition = { ...definition, hash: definitionHash(import.meta.url) };

import { definitionHash } from "../manifest.ts";
import type { Action, Artifact, Run } from "@j5/workflow-contracts";
import * as Handoff from "@j5/workflow-contracts/fh";
import * as Schema from "effect/Schema";
import { canonical, hash, type Definition, type Phase } from "../../workflow/Definition.ts";

const decodePublication = Schema.decodeUnknownSync(Handoff.Publication);
const decodeReviewHandoff = Schema.decodeUnknownSync(Handoff.ReviewHandoff);
const decodeValidation = Schema.decodeUnknownSync(Handoff.Validation);
const decodeWorkspace = Schema.decodeUnknownSync(Handoff.Workspace);

export const INSTRUCTIONS_VERSION = 2;
const instructions = {
  scout:
    "Inspect the repository and supplied evidence. Cite concrete paths. Separate confirmed facts from unknowns. Return {summary,evidence:string[],unknowns:string[]}.",
  navigator:
    "Produce a minimal implementation plan addressing the request and review feedback. Resolve unspecified product choices using the simplest option consistent with the request and supplied evidence. Record each choice in assumptions and never ask the user for clarification. Record required verification as executable/argument arrays, without shell expansion. Return {summary,steps:string[],checks:{executable,args:string[]}[],assumptions:string[]}.",
  advocate:
    "Review the latest plan for request completeness, user behavior, and supplied evidence. Findings are blocking only when the plan contradicts the request or supplied evidence, is infeasible, or lacks executable verification. Reasonable assumptions resolving unspecified product choices are non-blocking, but recording a choice as an assumption does not exempt it from the blocking criteria. Record preference disagreements as non-blocking findings for human consideration at plan approval. Never require user clarification or prior human approval. Return revise if and only if at least one finding is blocking; otherwise return accept, including when non-blocking findings exist. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied plan hash.",
  skeptic:
    "Review the latest plan for feasibility, hidden assumptions, failure modes, and sufficient executable verification. Findings are blocking only when the plan contradicts the request or supplied evidence, is infeasible, or lacks executable verification. Reasonable assumptions resolving unspecified product choices are non-blocking, but recording a choice as an assumption does not exempt it from the blocking criteria. Record preference disagreements as non-blocking findings for human consideration at plan approval. Never require user clarification or prior human approval. Return revise if and only if at least one finding is blocking; otherwise return accept, including when non-blocking findings exist. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied plan hash.",
  builder:
    "Implement only the latest approved plan in this workspace. Address review feedback and failed checks. Never commit, push, or create a PR. Return {summary,changes:string[]}.",
  critic:
    "Review the complete candidate changes against the approved plan and recorded validation. Do not modify files. Return revise if and only if at least one finding is blocking; otherwise return accept, including when non-blocking findings exist. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied codeIdentity.",
  sentry:
    "Review candidate changes for security, reliability, data loss, and regression risks. Do not modify files. Return revise if and only if at least one finding is blocking; otherwise return accept, including when non-blocking findings exist. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied codeIdentity.",
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
const decisionsIn = (run: Run, phase: "plan_approval" | "publication_approval") =>
  run.approvals.filter((decision) => decision.phase === phase);
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
        ...(validation
          ? matchingReviews(run, "code_review", decodeValidation(validation.content).codeIdentity)
          : []),
      ];
      decisions = [
        ...decisionsIn(run, "plan_approval").filter((decision) => decision.decision === "approve"),
        ...publicationChanges,
      ];
      break;
    case "critic":
    case "sentry":
      artifacts = [workspace, context, plan, build, validation];
      decisions = publicationChanges;
      break;
  }
  return { artifacts: uniqueArtifacts(artifacts), decisions };
}

const codeEvidence = (run: Run, task: string) => {
  const planApproval = decisionsIn(run, "plan_approval").findLast(
    (decision) => decision.decision === "approve",
  );
  const publicationApproval = decisionsIn(run, "publication_approval").findLast(
    (decision) => decision.decision === "approve",
  );
  switch (task) {
    case "workspace":
      return { artifacts: [], decisions: [] };
    case "validation":
      return { artifacts: uniqueArtifacts([lastIn(run, "plan")]), decisions: [planApproval] };
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
  taskPhase("validation", "code", ["validation"], { pass: "code_review", revise: "build" }, 3),
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
  version: 2,
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
    const personaId = task.id as keyof typeof instructions;
    const inputs = developmentInputs(run.inputs);
    const selected = selectAgentEvidence(run, personaId);
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
      worktree: workspace.worktree,
      branch: workspace.branch,
      selectedEvidenceIds,
      selectedEvidenceHashes,
      prompt: `Workflow operating instructions v${INSTRUCTIONS_VERSION}. ${instructions[personaId]}\nReturn ONLY one JSON object. Do not invoke other agents or change Git history.\n${canonical(
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
    return "pass";
  },
  gateArtifacts: (run, phase) => {
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

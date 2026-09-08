import { definitionHash } from "../manifest.ts";
import type { Action, Artifact, Run } from "@j5/workflow-contracts";
import * as Handoff from "@j5/workflow-contracts/fh";
import * as Schema from "effect/Schema";
import { canonical, type Definition, type Phase } from "../../workflow/Definition.ts";

const decodePublication = Schema.decodeUnknownSync(Handoff.Publication);
const decodeReviewHandoff = Schema.decodeUnknownSync(Handoff.ReviewHandoff);
const decodeValidation = Schema.decodeUnknownSync(Handoff.Validation);
const decodeWorkspace = Schema.decodeUnknownSync(Handoff.Workspace);

export const INSTRUCTIONS_VERSION = 1;
const instructions = {
  scout:
    "Inspect the repository and supplied evidence. Cite concrete paths. Separate confirmed facts from unknowns. Return {summary,evidence:string[],unknowns:string[]}.",
  navigator:
    "Produce a minimal implementation plan addressing the request and review feedback. Record required verification as executable/argument arrays, without shell expansion. Return {summary,steps:string[],checks:{executable,args:string[]}[]}.",
  advocate:
    "Review the latest plan for request completeness, user behavior, and supplied evidence. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied plan hash.",
  skeptic:
    "Review the latest plan for feasibility, hidden assumptions, failure modes, and sufficient executable verification. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied plan hash.",
  builder:
    "Implement only the latest approved plan in this workspace. Address review feedback and failed checks. Never commit, push, or create a PR. Return {summary,changes:string[]}.",
  critic:
    "Review the complete candidate changes against the approved plan and recorded validation. Do not modify files. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied codeIdentity.",
  sentry:
    "Review candidate changes for security, reliability, data loss, and regression risks. Do not modify files. Return {verdict:'accept'|'revise',subjectHash,findings:{blocking:boolean,description:string}[]} using the supplied codeIdentity.",
} as const;

export const latest = (run: Run, phase: string): Artifact => {
  const artifact = run.artifacts.findLast((item) => item.phase === phase);
  if (!artifact) throw new Error(`Missing ${phase} artifact`);
  return artifact;
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
  taskPhase("plan", "agent", ["navigator"], { pass: "plan_review" }, 3),
  taskPhase(
    "plan_review",
    "agent",
    ["advocate", "skeptic"],
    { pass: "plan_approval", revise: "plan" },
    3,
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
  version: 1,
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
    if (phase.kind !== "agent") return { inputs: run.inputs };
    const workspace = decodeWorkspace(latest(run, "workspace").content);
    const personaId = task.id as keyof typeof instructions;
    return {
      personaId,
      worktree: workspace.worktree,
      branch: workspace.branch,
      prompt: `Workflow operating instructions v${INSTRUCTIONS_VERSION}. ${instructions[personaId]}\nReturn ONLY one JSON object. Do not invoke other agents or change Git history.\n${canonical({ request: run.inputs, baseCommit: run.baseCommit, artifacts: run.artifacts, decisions: run.approvals })}`,
    };
  },
  outcome: (_run, phase, artifacts) => {
    if (["plan_review", "code_review"].includes(phase.id)) {
      return artifacts.every((artifact) => {
        const review = decodeReviewHandoff(artifact.content);
        return review.verdict === "accept" && !review.findings.some((finding) => finding.blocking);
      })
        ? "pass"
        : "revise";
    }
    if (phase.id === "validation")
      return decodeValidation(artifacts[0]!.content).passed ? "pass" : "revise";
    return "pass";
  },
  gateArtifacts: (run, phase) => {
    const reviewPhase = phase.id === "plan_approval" ? "plan_review" : "code_review";
    const subject = latest(run, phase.id === "plan_approval" ? "plan" : "metadata");
    const reviews = run.artifacts.filter((item) => item.phase === reviewPhase).slice(-2);
    if (reviews.length !== 2) throw new Error("Both required reviewers must provide evidence");
    return [subject, ...reviews];
  },
};

export const development: Definition = { ...definition, hash: definitionHash(import.meta.url) };

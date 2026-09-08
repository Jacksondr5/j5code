import type { Run } from "@j5/workflow-contracts";
import * as Handoff from "@j5/workflow-contracts/fh";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { development, latest } from "./development.ts";
import { gateHash, phaseById } from "../../workflow/Definition.ts";
import * as Workspace from "./GitWorkspace.ts";
import * as Publication from "./Publication.ts";
import { WorkflowError } from "../../workflow/Store.ts";
import type { Adapter } from "../../workflow/Worker.ts";

export const DevelopmentInputs = Schema.Struct({
  request: Schema.String,
  baseRef: Schema.String,
  evidence: Schema.Array(Schema.String),
});

const decodeDevelopmentInputs = Schema.decodeUnknownSync(DevelopmentInputs);
const decodeCodeCompleteHandoff = Schema.decodeUnknownSync(Handoff.CodeCompleteHandoff);
const decodeCommitResult = Schema.decodeUnknownSync(Handoff.CommitResult);
const decodePlanHandoff = Schema.decodeUnknownSync(Handoff.PlanHandoff);
const decodePublication = Schema.decodeUnknownSync(Handoff.Publication);
const decodePushResult = Schema.decodeUnknownSync(Handoff.PushResult);
const decodeValidation = Schema.decodeUnknownSync(Handoff.Validation);
const decodeWorkspace = Schema.decodeUnknownSync(Handoff.Workspace);
export function makeCodeAdapters(
  root: string,
  github = Publication.github,
): Record<string, Adapter> {
  const running = new Map<string, AbortController>();
  const getWorkspace = (run: Run) => decodeWorkspace(latest(run, "workspace").content);
  const metadata = (run: Run) => decodePublication(latest(run, "metadata").content);
  const requireApproval = (run: Run, phase: string) => {
    const reviewedHash = gateHash(development.gateArtifacts(run, phaseById(development, phase)));
    if (
      !run.approvals.some(
        (approval) => approval.decision === "approve" && approval.artifactHash === reviewedHash,
      )
    ) {
      throw new Error(`Exact ${phase} approval is missing`);
    }
  };
  const operations: Record<
    string,
    (run: Run, id: string, signal: AbortSignal) => Promise<unknown>
  > = {
    workspace: (run) => Workspace.workspace(run.repository, run.baseCommit, root, run.id),
    validation: async (run, id, signal) => {
      const plan = latest(run, "plan");
      requireApproval(run, "plan_approval");
      return Workspace.validation(
        getWorkspace(run).worktree,
        run.baseCommit,
        decodePlanHandoff(plan.content).checks,
        root,
        id,
        signal,
      );
    },
    metadata: async (run) => {
      const validation = decodeValidation(latest(run, "validation").content);
      const current = await Workspace.candidate(getWorkspace(run).worktree, run.baseCommit);
      if (!validation.passed || current.codeIdentity !== validation.codeIdentity)
        throw new Error("Validated code changed");
      const handoff = decodeCodeCompleteHandoff(latest(run, "build").content);
      const inputs = decodeDevelopmentInputs(run.inputs);
      return {
        ...current,
        diff: await Workspace.git(getWorkspace(run).worktree, [
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          run.baseCommit,
          current.tree,
          "--",
        ]),
        repository: await Workspace.git(run.repository, ["remote", "get-url", "origin"]),
        baseBranch: inputs.baseRef.replace(/^origin\//, ""),
        headBranch: getWorkspace(run).branch,
        commitMessage: `feat: ${handoff.summary.split("\n")[0]!.slice(0, 100)}`,
        title: handoff.summary.split("\n")[0]!.slice(0, 120),
        body: `${handoff.summary}\n\nValidation: ${validation.checks.map((check) => `${check.executable} ${check.args.join(" ")}`).join(", ")}\n\nWorkflow: ${run.id}`,
      };
    },
    commit: (run) => {
      requireApproval(run, "publication_approval");
      return Publication.commit(getWorkspace(run).worktree, run.baseCommit, metadata(run));
    },
    push: (run) => {
      requireApproval(run, "publication_approval");
      return Publication.push(
        getWorkspace(run).worktree,
        run.baseCommit,
        metadata(run),
        decodeCommitResult(latest(run, "commit").content).commit,
      );
    },
    draft: async (run) => {
      requireApproval(run, "publication_approval");
      const info = metadata(run);
      await Publication.verifyCandidate(getWorkspace(run).worktree, run.baseCommit, info);
      return Publication.draft(info, decodePushResult(latest(run, "push").content).commit, github);
    },
  };
  return Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      {
        recovery: name === "validation" ? "inspect" : "reconcile",
        reconcile: (action, run) =>
          Effect.tryPromise({
            try: async (signal) => {
              const controller = new AbortController();
              const stop = () => controller.abort();
              signal.addEventListener("abort", stop, { once: true });
              running.set(action.id, controller);
              try {
                return {
                  status: "completed" as const,
                  output: await Workspace.withCommandSignal(controller.signal, () =>
                    operation(run, action.id, controller.signal),
                  ),
                };
              } finally {
                running.delete(action.id);
                signal.removeEventListener("abort", stop);
              }
            },
            catch: (error) => new WorkflowError({ code: "invalid", detail: String(error) }),
          }),
        interrupt: (action) => Effect.sync(() => running.get(action.id)?.abort()),
      } satisfies Adapter,
    ]),
  );
}

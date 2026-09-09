import type { Run } from "@j5/workflow-contracts";
import * as Handoff from "@j5/workflow-contracts/fh";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { approvedCheckCorrection, development, effectiveChecks, latest } from "./development.ts";
import { canonical, gateHash, hash, phaseById } from "../../workflow/Definition.ts";
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
const decodePublication = Schema.decodeUnknownSync(Handoff.Publication);
const decodePushResult = Schema.decodeUnknownSync(Handoff.PushResult);
const decodeValidation = Schema.decodeUnknownSync(Handoff.Validation);
const decodeVerificationDiagnosis = Schema.decodeUnknownSync(Handoff.VerificationDiagnosis);
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
        (approval) =>
          approval.phase === phase &&
          approval.decision === "approve" &&
          approval.artifactHash === reviewedHash,
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
    metadata: async (run) => {
      const validation = decodeValidation(latest(run, "validation").content);
      const current = await Workspace.candidate(getWorkspace(run).worktree, run.baseCommit);
      const selected = effectiveChecks(run);
      const correctionApproval = selected.correction
        ? {
            gateRevision: selected.correction.approval.gateRevision,
            artifactHash: selected.correction.approval.artifactHash,
            actor: selected.correction.approval.actor,
          }
        : null;
      if (
        !validation.passed ||
        validation.checks.some((check) => check.exitCode !== 0) ||
        current.codeIdentity !== validation.codeIdentity ||
        validation.effectiveChecksHash !== hash(selected.checks) ||
        canonical(validation.correctionApproval) !== canonical(correctionApproval) ||
        validation.checks.length !== selected.checks.length ||
        validation.checks.some(
          (result, index) =>
            canonical({ executable: result.executable, args: result.args }) !==
            canonical(selected.checks[index]),
        )
      )
        throw new Error("Validated code or verification evidence changed");
      const handoff = decodeCodeCompleteHandoff(latest(run, "build").content);
      const inputs = decodeDevelopmentInputs(run.inputs);
      return {
        ...current,
        effectiveChecksHash: validation.effectiveChecksHash,
        correctionApproval: validation.correctionApproval,
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
        baseBranch: await Workspace.publicationBaseBranch(run.repository, inputs.baseRef),
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
  const adapters: Record<string, Adapter> = Object.fromEntries(
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
  const completed = (output: unknown) => Effect.succeed({ status: "completed" as const, output });
  const blocked = (cause: string, failureCategory = "revision_budget_exhausted" as const) =>
    Effect.succeed({ status: "blocked" as const, cause, recovery: null, failureCategory });
  adapters.validation = {
    recovery: "inspect",
    reconcile: (action, run) => {
      requireApproval(run, "plan_approval");
      const selected = effectiveChecks(run);
      if ((run.visits.validation ?? 0) > 3 && !selected.correction) {
        return blocked("A fourth validation is permitted only after an approved check correction");
      }
      return Effect.tryPromise({
        try: async (signal) => {
          const controller = new AbortController();
          const stop = () => controller.abort();
          signal.addEventListener("abort", stop, { once: true });
          running.set(action.id, controller);
          try {
            if (selected.correction) {
              const failed = decodeValidation(selected.correction.failed.content);
              const current = await Workspace.candidate(getWorkspace(run).worktree, run.baseCommit);
              if (current.codeIdentity !== failed.codeIdentity) {
                return {
                  status: "blocked" as const,
                  cause: "Candidate files changed after the corrected checks were proposed",
                  recovery: null,
                  failureCategory: "candidate_changed" as const,
                };
              }
            }
            const approval = selected.correction?.approval;
            return {
              status: "completed" as const,
              output: await Workspace.withCommandSignal(controller.signal, () =>
                Workspace.validation(
                  getWorkspace(run).worktree,
                  run.baseCommit,
                  selected.checks,
                  root,
                  action.id,
                  controller.signal,
                  approval
                    ? {
                        gateRevision: approval.gateRevision,
                        artifactHash: approval.artifactHash,
                        actor: approval.actor,
                      }
                    : null,
                ),
              ),
            };
          } finally {
            running.delete(action.id);
            signal.removeEventListener("abort", stop);
          }
        },
        catch: (error) => new WorkflowError({ code: "invalid", detail: String(error) }),
      });
    },
    interrupt: (action) => Effect.sync(() => running.get(action.id)?.abort()),
  } satisfies Adapter;
  adapters.repair_capacity = {
    recovery: "inspect",
    reconcile: (_action, run) => {
      const diagnosis = decodeVerificationDiagnosis(latest(run, "verification_diagnosis").content);
      if ((run.visits.build ?? 0) >= 3)
        return blocked(
          `No Builder capacity remains for ${diagnosis.outcome}: ${diagnosis.explanation}`,
        );
      if (
        (run.visits.validation ?? 0) >= 4 ||
        ((run.visits.validation ?? 0) >= 3 && !approvedCheckCorrection(run))
      )
        return blocked(
          `No validation capacity remains for ${diagnosis.outcome}: ${diagnosis.explanation}`,
        );
      return completed({ ready: true });
    },
    interrupt: () => Effect.void,
  } satisfies Adapter;
  adapters.verification_block = {
    recovery: "inspect",
    reconcile: (_action, run) => {
      const diagnosis = decodeVerificationDiagnosis(latest(run, "verification_diagnosis").content);
      return blocked(
        `Verification diagnosis could not resolve the failure: ${diagnosis.explanation}`,
      );
    },
    interrupt: () => Effect.void,
  } satisfies Adapter;
  return adapters;
}

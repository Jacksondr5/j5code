import type { Artifact } from "@j5/workflow-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { memo, useLayoutEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import {
  EvidenceDocument,
  LazyArtifact,
  Progress,
  Result,
  ReviewerSummary,
  Status,
} from "./RunsPageEvidence";
import { expectedNextStep, failureHeading, phaseLabel } from "./presentation";
import { useWorkflowRunDetail, type PendingWorkflowAction } from "./useWorkflowRunDetail";

const actionLabel: Record<PendingWorkflowAction, string> = {
  approve: "Submitting approval…",
  request_changes: "Requesting changes…",
  cancel: "Requesting cancellation…",
  recover: "Reconciling…",
  restart: "Restarting review…",
  save: "Saving…",
};

const GateEvidence = memo(function GateEvidence({
  evidence,
  reviews,
  validation,
}: {
  readonly evidence: readonly Artifact[];
  readonly reviews: readonly Artifact[];
  readonly validation: Artifact | undefined;
}) {
  const [fullOpen, setFullOpen] = useState(false);
  const metadata = evidence.find((artifact) => artifact.phase === "metadata")?.content;
  const identity =
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    "codeIdentity" in metadata
      ? String(metadata.codeIdentity)
      : null;
  return (
    <>
      <ReviewerSummary artifacts={[...reviews, ...evidence]} />
      {evidence.map((artifact) => (
        <div key={artifact.id} className="min-w-0 overflow-x-auto">
          <h4 className="mb-2 font-medium">
            {phaseLabel(artifact.phase)}{" "}
            <span className="text-xs text-muted-foreground">by {artifact.producer}</span>
          </h4>
          <EvidenceDocument content={artifact.content} />
        </div>
      ))}
      {validation ? (
        <details open>
          <summary className="cursor-pointer font-medium">
            Validation for candidate {identity?.slice(0, 12)}
          </summary>
          <div className="mt-2 min-w-0 overflow-x-auto">
            <EvidenceDocument content={validation.content} />
          </div>
        </details>
      ) : null}
      <details onToggle={(event) => setFullOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer font-medium">Full reviewer evidence</summary>
        {fullOpen ? (
          <div className="mt-3 space-y-3">
            {reviews.map((artifact) => (
              <div key={artifact.id} className="min-w-0 overflow-x-auto">
                <h4>{phaseLabel(artifact.producer)}</h4>
                <EvidenceDocument content={artifact.content} />
              </div>
            ))}
          </div>
        ) : null}
      </details>
    </>
  );
});

function GateDecisionForm({ model }: { readonly model: ReturnType<typeof useWorkflowRunDetail> }) {
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const { run } = model;
  if (!run?.gate) return null;
  return (
    <>
      {run.phase === "publication_approval" ? (
        <section className="space-y-3 rounded border p-3" aria-label="Publication text">
          <h4 className="font-medium">Publication text</h4>
          {(["commitMessage", "title", "body"] as const).map((field) => (
            <label className="block text-sm" key={field}>
              {field === "commitMessage"
                ? "Commit message"
                : field === "title"
                  ? "PR title"
                  : "PR body"}
              <Textarea
                aria-label={
                  field === "commitMessage"
                    ? "Commit message"
                    : field === "title"
                      ? "PR title"
                      : "PR body"
                }
                value={model.metadata[field]}
                onChange={(event) => model.beginDraft({ [field]: event.target.value })}
              />
            </label>
          ))}
          <Button
            disabled={
              model.pendingAction !== null ||
              !model.metadataDirty ||
              !model.metadata.commitMessage.trim() ||
              !model.metadata.title.trim()
            }
            variant="outline"
            onClick={() =>
              void model.submit(
                "save",
                `/${encodeURIComponent(run.id)}/metadata`,
                {
                  ...model.metadata,
                  expectedRevision: run.revision,
                  gateRevision: run.gate!.revision,
                  artifactHash: run.gate!.artifactHash,
                },
                "Publication text saved; review the new gate version before approving",
              )
            }
          >
            {model.pendingAction === "save" ? actionLabel.save : "Save changes"}
          </Button>
          <p
            className={`text-sm ${model.metadataDirty ? "text-warning" : "text-muted-foreground"}`}
          >
            {model.metadataDirty
              ? "Save changes before approving."
              : `Saved as gate revision ${run.gate.revision}. Approve to publish this version.`}
          </p>
        </section>
      ) : null}
      <div className="sticky bottom-0 space-y-3 rounded-md border bg-background/95 p-3 shadow-sm backdrop-blur">
        <Textarea
          ref={feedbackRef}
          aria-label="Review feedback"
          value={model.feedbackText}
          onChange={(event) =>
            model.setFeedback({
              runId: run.id,
              gateHash: run.gate!.artifactHash,
              text: event.target.value,
            })
          }
          placeholder={`Feedback sent to ${
            run.phase === "publication_approval"
              ? "implementation"
              : run.phase === "checks_approval"
                ? "verification diagnosis"
                : "plan revision"
          }`}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={model.pendingAction !== null || model.metadataDirty}
            title={model.metadataDirty ? "Save changes before approving" : undefined}
            onClick={() => model.decide("approve")}
          >
            {model.pendingAction === "approve"
              ? actionLabel.approve
              : run.phase === "publication_approval"
                ? "Approve and publish"
                : run.phase === "checks_approval"
                  ? "Approve corrected checks"
                  : "Approve plan"}
          </Button>
          <Button
            disabled={model.pendingAction !== null}
            variant="outline"
            onClick={() => {
              if (!model.feedbackText.trim()) {
                model.setMutationError("Describe the requested change before sending it.");
                feedbackRef.current?.focus();
                return;
              }
              model.decide("request_changes");
            }}
          >
            {model.pendingAction === "request_changes"
              ? actionLabel.request_changes
              : "Request changes"}
          </Button>
          <Button variant="ghost" onClick={() => feedbackRef.current?.focus()}>
            Add feedback
          </Button>
        </div>
      </div>
    </>
  );
}

export function WorkflowRunOverview({
  environmentId,
  runId,
  revealApproval = false,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
  readonly revealApproval?: boolean;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  const model = useWorkflowRunDetail(environmentId, runId);
  const approvalRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (revealApproval && model.run?.status === "waiting_approval")
      approvalRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [model.run?.status, revealApproval]);
  if (model.readError)
    return (
      <p role="alert" className="rounded border border-destructive p-3">
        Workflow data unavailable: {model.readError}
      </p>
    );
  if (!model.run)
    return <section className="rounded-lg border p-8 text-center">Loading workflow…</section>;
  const run = model.run;
  return (
    <section className="min-w-0 space-y-4">
      {model.mutationError ? (
        <p role="alert" className="rounded border border-destructive p-3">
          {model.mutationError}
        </p>
      ) : null}
      {model.success ? (
        <p role="status" className="rounded border border-success/40 bg-success/5 p-3">
          {model.success}
        </p>
      ) : null}
      {model.artifactLoading ? (
        <p className="text-sm text-muted-foreground">Loading current evidence…</p>
      ) : null}
      {model.artifactError ? (
        <p role="alert" className="rounded border border-destructive p-3">
          Evidence unavailable: {model.artifactError}
        </p>
      ) : null}
      {model.displacedDraft ? (
        <details className="rounded border border-warning p-3">
          <summary className="cursor-pointer font-medium">
            Unsaved publication text from the replaced gate
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
            {JSON.stringify(model.displacedDraft, null, 2)}
          </pre>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() =>
              void navigator.clipboard.writeText(JSON.stringify(model.displacedDraft, null, 2))
            }
          >
            Copy draft
          </Button>
        </details>
      ) : null}
      {model.displacedFeedback ? (
        <div className="rounded border border-warning p-3">
          <p className="font-medium">Feedback from replaced approval evidence</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{model.displacedFeedback}</p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(model.displacedFeedback ?? "")}
          >
            Copy feedback
          </Button>
        </div>
      ) : null}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 break-words text-xl font-semibold">{run.request}</h2>
          <Status status={run.status} />
        </div>
        <p>
          {phaseLabel(run.phase)} · {expectedNextStep(run, model.definition)}
        </p>
        <p className="text-sm text-muted-foreground">
          Squadron: <span className="break-all">{run.squadronId}</span> · Repository:{" "}
          <span className="break-all">{run.repository}</span>
        </p>
      </div>
      <Progress definition={model.definition} run={run} />
      {run.cause ? (
        <section className="rounded-lg border border-warning p-4" role="status">
          <h3 className="font-semibold">{failureHeading(run)}</h3>
          <p className="mt-1 text-sm">
            {run.recovery === "retry"
              ? "The server can reconcile the same action identity and deadline; this does not reset its attempt budget."
              : run.recovery === "retry_restart"
                ? "The replacement review is waiting for reviewer cleanup to be retried."
                : run.recovery === "restore_definition"
                  ? "Restore the exact pinned definition version before continuing."
                  : run.recovery === "inspect_external_result"
                    ? "Inspect the linked external work. No automatic retry is supported for this action."
                    : run.restartAvailability.reason}
          </p>
          {run.restartAvailability.available || run.recovery === "retry_restart" ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-muted-foreground">
                Attempt {run.restart?.visit ?? run.restartAvailability.nextVisit} of{" "}
                {run.restartAvailability.maxVisits}. Replacement reviewers receive a fresh 30-minute
                deadline; earlier evidence remains in this run.
              </p>
              {run.restartAvailability.compatibleDefinitionUpgrade ? (
                <p className="text-sm text-muted-foreground">
                  This saved plan review can be upgraded to the compatible workflow engine. The old
                  and new definition hashes and your identity will be recorded.
                </p>
              ) : null}
              {(() => {
                const failed = run.actions.find(
                  (action) => action.id === run.relevantActionId && action.externalIdentity,
                );
                return failed ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Previous deadline: {new Date(failed.deadline).toLocaleString()}
                    </p>
                    {failed.externalIdentity ? (
                      onOpenThread ? (
                        <Button
                          size="sm"
                          variant="link"
                          onClick={() => onOpenThread(failed.externalIdentity!.split("/")[0]!)}
                        >
                          Open failed reviewer conversation
                        </Button>
                      ) : (
                        <Link
                          className="text-sm underline"
                          to="/$environmentId/$threadId"
                          params={{
                            environmentId,
                            threadId: ThreadId.make(failed.externalIdentity.split("/")[0]!),
                          }}
                        >
                          Open failed reviewer conversation
                        </Link>
                      )
                    ) : null}
                  </>
                ) : null;
              })()}
              <Button
                disabled={model.pendingAction !== null}
                onClick={() =>
                  void model.submit(
                    "restart",
                    `/${encodeURIComponent(run.id)}/restart-phase`,
                    {
                      expectedRevision: run.revision,
                      definitionHash:
                        run.restart?.targetDefinitionHash ??
                        run.restartAvailability.targetDefinitionHash,
                    },
                    run.recovery === "retry_restart"
                      ? "Reviewer cleanup retried"
                      : `${run.phase === "plan_review" ? "Plan" : "Code"} review restart requested`,
                  )
                }
              >
                {model.pendingAction === "restart"
                  ? actionLabel.restart
                  : run.recovery === "retry_restart"
                    ? "Retry restart"
                    : run.phase === "plan_review"
                      ? "Restart plan review"
                      : "Restart code review"}
              </Button>
            </div>
          ) : null}
          <details className="mt-2">
            <summary className="cursor-pointer text-sm">Technical detail</summary>
            <p className="mt-1 break-all text-xs">
              {run.cause}
              {run.relevantActionId ? ` · Action ${run.relevantActionId}` : ""}
            </p>
          </details>
        </section>
      ) : null}
      {run.gate ? (
        <section
          id="workflow-approval"
          data-workflow-run-id={run.id}
          ref={approvalRef}
          aria-label="Approval evidence"
          className="scroll-mt-4 space-y-4 rounded-lg border-2 p-4"
        >
          <div>
            <h3 className="font-semibold">
              {run.phase === "publication_approval"
                ? "Review publication evidence"
                : run.phase === "checks_approval"
                  ? "Approve corrected checks"
                  : "Review plan and verification commands"}
            </h3>
            <p className="text-sm text-muted-foreground">
              Your decision applies only to gate revision {run.gate.revision} and the evidence
              listed here.
            </p>
          </div>
          <GateEvidence
            evidence={model.gateEvidence}
            reviews={model.gateReviews}
            validation={model.publicationValidation}
          />
          <GateDecisionForm model={model} />
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Technical gate identity
            </summary>
            <p className="break-all text-xs">
              Revision {run.gate.revision} · {run.gate.artifactHash}
            </p>
          </details>
        </section>
      ) : null}
      {run.status === "blocked" && ["retry", "restore_definition"].includes(run.recovery ?? "") ? (
        <Button
          disabled={model.pendingAction !== null}
          onClick={() =>
            void model.submit(
              "recover",
              `/${encodeURIComponent(run.id)}/retry`,
              { expectedRevision: run.revision },
              run.recovery === "retry"
                ? "Reconciliation requested"
                : "Definition recovery requested",
            )
          }
        >
          {model.pendingAction === "recover"
            ? actionLabel.recover
            : run.recovery === "retry"
              ? "Reconcile action"
              : "Check restored definition"}
        </Button>
      ) : null}
      {["running", "restarting", "waiting_approval", "blocked"].includes(run.status) ? (
        <div className="rounded-lg border border-destructive/30 p-4">
          <h3 className="font-medium">Stop workflow</h3>
          <p className="mb-3 text-sm text-muted-foreground">
            Stops successor work and interrupts owned work. Artifacts, worktrees, and completed
            publication results are retained.
          </p>
          <Button
            disabled={model.pendingAction !== null}
            variant="destructive"
            onClick={() => model.setCancelOpen(true)}
          >
            Cancel workflow
          </Button>
        </div>
      ) : null}
      <Result artifacts={model.artifacts} />
      <details className="rounded-lg border p-4" open={model.hasOpenActions}>
        <summary className="cursor-pointer font-semibold">Current activity and history</summary>
        <div className="mt-3 space-y-4">
          {model.actionGroups.map((group) => (
            <section key={group.phase}>
              <h4 className="font-medium">{phaseLabel(group.phase)}</h4>
              <ul className="text-sm">
                {group.actions.map((action) => (
                  <li className="py-1 break-words" key={action.id}>
                    {action.task} · attempt {action.attempt} · {phaseLabel(action.status)}
                    {action.externalIdentity ? (
                      onOpenThread ? (
                        <Button
                          size="sm"
                          variant="link"
                          onClick={() => onOpenThread(action.externalIdentity!.split("/")[0]!)}
                        >
                          Open agent thread
                        </Button>
                      ) : (
                        <Link
                          className="ml-2 underline"
                          to="/$environmentId/$threadId"
                          params={{
                            environmentId,
                            threadId: ThreadId.make(action.externalIdentity.split("/")[0]!),
                          }}
                        >
                          Open agent thread
                        </Link>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </details>
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer font-semibold">Previous revisions and artifacts</summary>
        <div className="mt-3 space-y-3">
          {model.historicalArtifacts.map((artifact) => (
            <LazyArtifact
              artifact={artifact}
              environmentId={environmentId}
              key={`${artifact.id}:${artifact.hash}`}
              runId={run.id}
            />
          ))}
        </div>
      </details>
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer font-semibold">Technical details</summary>
        <dl className="mt-2 grid gap-2 break-all text-xs">
          <div>
            <dt>Run ID</dt>
            <dd>{run.id}</dd>
          </div>
          <div>
            <dt>State revision</dt>
            <dd>{run.revision}</dd>
          </div>
          <div>
            <dt>Pinned definition</dt>
            <dd>
              {run.definitionId} v{run.definitionVersion} · {run.definitionHash}
            </dd>
          </div>
          <div>
            <dt>Base commit</dt>
            <dd>{run.baseCommit}</dd>
          </div>
        </dl>
      </details>
      <section>
        <h3 className="font-semibold">Decision history</h3>
        <ul>
          {run.approvals.map((approval) => (
            <li
              className="text-sm break-words"
              key={`${approval.gateRevision}:${approval.artifactHash}:${approval.actor}:${approval.decision}`}
            >
              {approval.actor}: {phaseLabel(approval.decision)} · gate {approval.gateRevision}
              {approval.feedback && ` — ${approval.feedback}`}
            </li>
          ))}
        </ul>
      </section>
      <AlertDialog open={model.cancelOpen} onOpenChange={model.setCancelOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              Successor work will stop and owned work will be interrupted. Recorded evidence,
              worktrees, and completed publication are retained.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep workflow</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => {
                model.setCancelOpen(false);
                if (run.gate) model.decide("cancel");
                else
                  void model.submit(
                    "cancel",
                    `/${encodeURIComponent(run.id)}/cancel`,
                    { expectedRevision: run.revision },
                    "Cancellation requested",
                  );
              }}
            >
              Request cancellation
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

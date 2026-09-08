import type { Artifact, Run, WorkflowDefinitionPresentation } from "@j5/workflow-contracts";
import type { WorkflowEntry } from "@j5/workflow-contracts/sidebar";
import { ThreadId } from "@t3tools/contracts";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { SidebarInset } from "../../components/ui/sidebar";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { listSquadrons, type ManagedSquadron } from "../squadron/squadronClient";
import { ReviewDocument } from "./ReviewDocument";
import { listWorkflowDefinitions, listWorkflowEntries, mutateRun, readRun } from "./client";
import {
  exactAndRelativeTime,
  expectedNextStep,
  failureHeading,
  phaseLabel,
  statusPresentation,
} from "./presentation";

type PendingAction = "start" | "approve" | "request_changes" | "cancel" | "recover" | "save";
type Metadata = { commitMessage: string; title: string; body: string };
type MetadataDraft = Metadata & {
  runId: string;
  gateRevision: number;
  gateHash: string;
  saved: Metadata;
};

const emptyMetadata: Metadata = { commitMessage: "", title: "", body: "" };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const metadataFrom = (artifact: Artifact | undefined): Metadata => {
  const content = artifact?.content;
  return record(content)
    ? {
        commitMessage: String(content.commitMessage ?? ""),
        title: String(content.title ?? ""),
        body: String(content.body ?? ""),
      }
    : emptyMetadata;
};
const sameMetadata = (left: Metadata, right: Metadata) =>
  left.commitMessage === right.commitMessage &&
  left.title === right.title &&
  left.body === right.body;
const actionLabel: Record<PendingAction, string> = {
  start: "Starting…",
  approve: "Submitting approval…",
  request_changes: "Requesting changes…",
  cancel: "Requesting cancellation…",
  recover: "Reconciling…",
  save: "Saving…",
};

function Status({ status }: { status: Run["status"] }) {
  const presentation = statusPresentation[status];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium">
      <span aria-hidden>{presentation.marker}</span>
      {presentation.label}
    </span>
  );
}

function ReviewerSummary({ artifacts }: { artifacts: readonly Artifact[] }) {
  const reviews = artifacts.filter(
    (artifact) => record(artifact.content) && "verdict" in artifact.content,
  );
  if (!reviews.length) return null;
  const findings = reviews.flatMap((artifact) => {
    const content = artifact.content as Record<string, unknown>;
    return Array.isArray(content.findings) ? content.findings.filter(record) : [];
  });
  const blocking = findings.filter((finding) => finding.blocking === true).length;
  const accepted = reviews.filter(
    (artifact) => (artifact.content as Record<string, unknown>).verdict === "accept",
  ).length;
  return (
    <div className="rounded-md bg-muted p-3 text-sm">
      <strong>Reviewer summary:</strong> {accepted} of {reviews.length} accepted · {blocking}{" "}
      blocking · {findings.length - blocking} non-blocking findings
    </div>
  );
}

function Progress({
  run,
  definition,
}: {
  run: Run;
  definition: WorkflowDefinitionPresentation | undefined;
}) {
  const current = definition?.phases.findIndex((phase) => phase.id === run.phase) ?? -1;
  const currentPhase = definition?.phases[current];
  const visits = run.visits[run.phase] ?? 0;
  return (
    <section className="rounded-lg border p-4" aria-label="Workflow progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Current: {phaseLabel(run.phase)}</h3>
          <p className="text-sm text-muted-foreground">{expectedNextStep(run, definition)}</p>
        </div>
        {currentPhase && currentPhase.maxVisits > 1 && (
          <span className="text-sm">
            {phaseLabel(run.phase)} attempt {visits} of {currentPhase.maxVisits}
          </span>
        )}
      </div>
      {definition ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">
            All {definition.phases.length} phases
          </summary>
          <ol className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            {definition.phases.map((phase, index) => {
              const phaseVisits = run.visits[phase.id] ?? 0;
              return (
                <li
                  className={`rounded border p-2 ${index === current ? "border-primary" : ""}`}
                  key={phase.id}
                >
                  {index + 1}. {phaseLabel(phase.id)} {phase.kind === "gate" && "· Human gate"}
                  <span className="block text-xs text-muted-foreground">
                    {phaseVisits
                      ? `Visited ${phaseVisits} time${phaseVisits === 1 ? "" : "s"}; current validity depends on later transitions.`
                      : "Not visited"}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            Automatic reviews and human change requests share phase visit budgets. A visited phase
            may be invalidated by a backwards transition.
          </p>
        </details>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Detailed progress is unavailable because this run’s pinned definition could not be loaded.
        </p>
      )}
    </section>
  );
}

function Result({ run }: { run: Run }) {
  const commit = run.artifacts.findLast((artifact) => artifact.phase === "commit");
  const push = run.artifacts.findLast((artifact) => artifact.phase === "push");
  const draft = run.artifacts.findLast((artifact) => artifact.phase === "draft");
  if (!commit && !push && !draft) return null;
  const value = (artifact: Artifact | undefined, key: string) =>
    artifact && record(artifact.content) ? String(artifact.content[key] ?? "") : "";
  const url = value(draft, "url");
  return (
    <section className="rounded-lg border p-4">
      <h3 className="font-semibold">Publication result</h3>
      <dl className="mt-2 grid gap-2 text-sm">
        {commit && (
          <div>
            <dt className="text-muted-foreground">Commit</dt>
            <dd className="break-all">{value(commit, "commit")}</dd>
          </div>
        )}
        {push && (
          <div>
            <dt className="text-muted-foreground">Pushed SHA</dt>
            <dd className="break-all">{value(push, "remoteSha")}</dd>
          </div>
        )}
        {url && (
          <div>
            <dt className="text-muted-foreground">Draft pull request</dt>
            <dd>
              <a className="underline" href={url} rel="noreferrer" target="_blank">
                {url}
              </a>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

export function RunsPage() {
  const environmentId = usePrimaryEnvironmentId();
  const search = useSearch({ from: "/runs" });
  const navigate = useNavigate();
  const targetHash = useLocation({ select: (location) => location.hash });
  const approvalRef = useRef<HTMLElement | null>(null);
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef<string | null>(search.runId ?? null);
  const [squadrons, setSquadrons] = useState<readonly ManagedSquadron[]>([]);
  const [scope, setScope] = useState(search.squadronId ?? "");
  const [createSquadron, setCreateSquadron] = useState(search.squadronId ?? "");
  const [runs, setRuns] = useState<readonly WorkflowEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [run, setRun] = useState<Run | null>(null);
  const [definitions, setDefinitions] = useState<readonly WorkflowDefinitionPresentation[]>([]);
  const [request, setRequest] = useState("");
  const [baseRef, setBaseRef] = useState("main");
  const [feedback, setFeedback] = useState<{
    runId: string;
    gateHash: string;
    text: string;
  } | null>(null);
  const [metadataDraft, setMetadataDraft] = useState<MetadataDraft | null>(null);
  const [displacedDraft, setDisplacedDraft] = useState<MetadataDraft | null>(null);
  const [displacedFeedback, setDisplacedFeedback] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(search.newWorkflow === true);
  const commandAttempt = useRef<{ payload: string; commandId: string } | null>(null);
  const selected = search.runId ?? null;

  useEffect(() => {
    selectionRef.current = selected;
  }, [selected]);

  useEffect(() => {
    if (search.squadronId !== undefined && search.squadronId !== scope) {
      setScope(search.squadronId);
      setOffset(0);
    }
    if (search.newWorkflow === true) setCreateOpen(true);
  }, [scope, search.newWorkflow, search.squadronId]);

  const setSelected = useCallback(
    (id: string | null, squadronId = scope) => {
      selectionRef.current = id;
      void navigate({
        to: "/runs",
        search: {
          runId: id ?? undefined,
          squadronId: squadronId || undefined,
          newWorkflow: undefined,
        },
        hash: id ? "workflow-approval" : "",
        replace: true,
      });
    },
    [navigate, scope],
  );

  useLayoutEffect(() => {
    if (
      run?.id === selected &&
      run.status === "waiting_approval" &&
      targetHash === "workflow-approval"
    )
      approvalRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [selected, run?.id, run?.status, targetHash]);

  useEffect(() => {
    setFeedback(null);
    setMetadataDraft(null);
    setDisplacedDraft(null);
    setDisplacedFeedback(null);
    setMutationError(null);
    setSuccess(null);
  }, [selected]);

  useEffect(() => {
    void Promise.all([listSquadrons(), listWorkflowDefinitions()])
      .then(([items, availableDefinitions]) => {
        setSquadrons(items);
        setDefinitions(availableDefinitions);
        const firstEligible = items.find((item) => item.projectIds.length === 1)?.squadron.id ?? "";
        setCreateSquadron((current) => current || firstEligible);
      })
      .catch((cause) => setReadError(String(cause)));
  }, []);

  const refresh = useCallback(async () => {
    const requestedSelection = selected;
    const [page, detail] = await Promise.all([
      listWorkflowEntries(scope, "", offset),
      requestedSelection ? readRun(requestedSelection) : Promise.resolve(null),
    ]);
    if (selectionRef.current !== requestedSelection) return;
    setRuns(page.runs);
    setTotal(page.total);
    setRun(detail);
    setReadError(null);
  }, [offset, scope, selected]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let interval: number | undefined;
    const update = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        await refresh();
      } catch (cause) {
        if (active) setReadError(String(cause));
      } finally {
        inFlight = false;
      }
    };
    const sync = () => {
      window.clearInterval(interval);
      interval =
        document.visibilityState === "visible"
          ? window.setInterval(() => void update(), 7_500)
          : undefined;
    };
    void update();
    sync();
    const reconnect = () => {
      if (document.visibilityState === "visible") void update();
      sync();
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    window.addEventListener("j5-workflows-changed", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      window.removeEventListener("j5-workflows-changed", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
    };
  }, [refresh]);

  const gateArtifacts = run?.gate
    ? run.gate.artifactIds.flatMap(
        (id) => run.artifacts.find((artifact) => artifact.id === id) ?? [],
      )
    : [];
  const savedMetadata = metadataFrom(
    gateArtifacts.find((artifact) => artifact.phase === "metadata"),
  );
  const appliedDraft =
    metadataDraft &&
    metadataDraft.runId === run?.id &&
    metadataDraft.gateRevision === run?.gate?.revision &&
    metadataDraft.gateHash === run?.gate?.artifactHash
      ? metadataDraft
      : null;
  const metadata: Metadata = appliedDraft ?? savedMetadata;
  const metadataDirty = appliedDraft !== null && !sameMetadata(appliedDraft, appliedDraft.saved);
  const appliedFeedback =
    feedback && feedback.runId === run?.id && feedback.gateHash === run?.gate?.artifactHash
      ? feedback
      : null;
  const feedbackText = appliedFeedback?.text ?? "";

  useEffect(() => {
    if (!metadataDraft || !run?.gate || metadataDraft.runId !== run.id) return;
    if (
      metadataDraft.gateRevision === run.gate.revision &&
      metadataDraft.gateHash === run.gate.artifactHash
    )
      return;
    if (!sameMetadata(metadataDraft, metadataDraft.saved)) setDisplacedDraft(metadataDraft);
    setMetadataDraft(null);
    setMutationError(
      "The approval evidence changed. Review the refreshed gate and submit a new decision.",
    );
  }, [metadataDraft, run?.gate, run?.id]);

  useEffect(() => {
    if (!feedback || !run?.gate || feedback.runId !== run.id) return;
    if (feedback.gateHash === run.gate.artifactHash) return;
    if (feedback.text.trim()) setDisplacedFeedback(feedback.text);
    setFeedback(null);
  }, [feedback, run?.gate, run?.id]);

  const submit = async (
    action: PendingAction,
    path: string,
    body: Record<string, unknown>,
    acceptedMessage: string,
  ) => {
    setPendingAction(action);
    setMutationError(null);
    setRefreshWarning(null);
    const payload = JSON.stringify({ path, body });
    if (commandAttempt.current?.payload !== payload)
      commandAttempt.current = { payload, commandId: window.crypto.randomUUID() };
    const originSelection = selectionRef.current;
    try {
      const next = await mutateRun(path, {
        ...body,
        commandId: commandAttempt.current.commandId,
      });
      commandAttempt.current = null;
      setSuccess(acceptedMessage);
      toastManager.add({ type: "success", title: acceptedMessage });
      if (action === "start") {
        setCreateOpen(false);
        setRequest("");
        setScope(next.squadronId);
        setOffset(0);
        setSelected(next.id, next.squadronId);
        setRun(next);
      } else if (selectionRef.current === originSelection && next.id === originSelection) {
        setRun(next);
        setFeedback(null);
        if (action === "save") {
          const saved = metadataFrom(
            next.artifacts.find((artifact) => artifact.id === next.gate?.artifactIds[0]),
          );
          setMetadataDraft(
            next.gate
              ? {
                  ...saved,
                  saved,
                  runId: next.id,
                  gateRevision: next.gate.revision,
                  gateHash: next.gate.artifactHash,
                }
              : null,
          );
        } else setMetadataDraft(null);
      }
      try {
        const page = await listWorkflowEntries(action === "start" ? next.squadronId : scope, "", 0);
        setRuns(page.runs);
        setTotal(page.total);
      } catch {
        setRefreshWarning(
          "The action was accepted, but the workflow list could not be refreshed. Its entries may be stale.",
        );
      }
    } catch (cause) {
      const message = String(cause);
      setMutationError(message);
      toastManager.add({
        type: "error",
        title: `${phaseLabel(action)} failed`,
        description: message,
      });
      if (/changed|conflict|revision|gate/i.test(message) && originSelection) {
        try {
          const fresh = await readRun(originSelection);
          if (selectionRef.current === originSelection) setRun(fresh);
        } catch {
          setRefreshWarning(
            "The request was rejected and refreshed evidence is temporarily unavailable.",
          );
        }
      }
    } finally {
      setPendingAction(null);
    }
  };

  const decide = (decision: "approve" | "request_changes" | "cancel") => {
    if (!run?.gate) return;
    const accepted =
      decision === "approve"
        ? run.phase === "publication_approval"
          ? "Publication approved; publishing"
          : "Plan approved; implementation starting"
        : decision === "request_changes"
          ? run.phase === "publication_approval"
            ? "Changes requested; returning to implementation"
            : "Changes requested; revising the plan"
          : "Cancellation requested";
    void submit(
      decision === "cancel" ? "cancel" : decision,
      `/${encodeURIComponent(run.id)}/decide`,
      {
        expectedRevision: run.revision,
        gateRevision: run.gate.revision,
        artifactHash: run.gate.artifactHash,
        decision,
        feedback: feedbackText,
      },
      accepted,
    );
  };

  const definition = definitions.find(
    (item) =>
      item.id === run?.definitionId &&
      item.version === run.definitionVersion &&
      item.hash === run.definitionHash,
  );
  const eligibleSquadrons = squadrons.filter((item) => item.projectIds.length === 1);
  const publicationIdentity = (() => {
    const content = gateArtifacts.find((artifact) => artifact.phase === "metadata")?.content;
    return record(content) && typeof content.codeIdentity === "string"
      ? content.codeIdentity
      : null;
  })();
  const publicationValidation = publicationIdentity
    ? run?.artifacts.findLast(
        (artifact) =>
          artifact.phase === "validation" &&
          record(artifact.content) &&
          artifact.content.codeIdentity === publicationIdentity,
      )
    : undefined;
  const beginDraft = (patch: Partial<Metadata>) => {
    if (!run?.gate) return;
    const basis: MetadataDraft = appliedDraft
      ? appliedDraft
      : {
          ...savedMetadata,
          saved: savedMetadata,
          runId: run.id,
          gateRevision: run.gate.revision,
          gateHash: run.gate.artifactHash,
        };
    setMetadataDraft({ ...basis, ...patch });
  };

  return (
    <SidebarInset className="min-h-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-6xl space-y-6 p-4 wco:pt-[calc(env(titlebar-area-height)+1rem)] sm:p-6 sm:wco:pt-[calc(env(titlebar-area-height)+1.5rem)]">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Workflows</h1>
            <p className="text-sm text-muted-foreground">
              Development requests, recorded evidence, and human decisions.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setCreateOpen(true)}>New workflow</Button>
            <Link className="self-center underline" to="/">
              Back to threads
            </Link>
          </div>
        </header>

        {readError && (
          <p role="alert" className="rounded border border-destructive p-3">
            Workflow data unavailable: {readError}
          </p>
        )}
        {mutationError && (
          <p role="alert" className="rounded border border-destructive p-3">
            {mutationError}
          </p>
        )}
        {success && (
          <p role="status" className="rounded border border-success/40 bg-success/5 p-3">
            {success}
          </p>
        )}
        {refreshWarning && (
          <p role="status" className="rounded border p-3">
            {refreshWarning}
          </p>
        )}
        {displacedDraft && (
          <details className="rounded border border-warning p-3">
            <summary className="cursor-pointer font-medium">
              Unsaved publication text from the replaced gate
            </summary>
            <p className="mt-2 text-sm">
              This draft was not attached to the new evidence. Copy anything you need before
              dismissing it.
            </p>
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
              {JSON.stringify(
                {
                  commitMessage: displacedDraft.commitMessage,
                  title: displacedDraft.title,
                  body: displacedDraft.body,
                },
                null,
                2,
              )}
            </pre>
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(JSON.stringify(displacedDraft, null, 2))
              }
            >
              Copy draft
            </Button>
          </details>
        )}
        {displacedFeedback && (
          <div className="rounded border border-warning p-3">
            <p className="font-medium">Feedback from replaced approval evidence</p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{displacedFeedback}</p>
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(displacedFeedback)}
            >
              Copy feedback
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            Browse Squadron
            <select
              className="mt-1 block rounded border bg-background p-2"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value);
                setOffset(0);
                setRun(null);
                setSelected(null, event.target.value);
              }}
            >
              <option value="">All Squadrons</option>
              {squadrons.map((item) => (
                <option key={item.squadron.id} value={item.squadron.id}>
                  {item.squadron.name}
                </option>
              ))}
            </select>
          </label>
          <span className="pb-2 text-sm text-muted-foreground">
            {total} {total === 1 ? "workflow" : "workflows"}
          </span>
        </div>

        <div className="grid gap-6 md:grid-cols-[17rem_minmax(0,1fr)]">
          <nav aria-label="Workflows" className="space-y-2">
            {!readError && runs.length === 0 && (
              <div className="rounded border p-4 text-sm">
                <p>No workflows in this scope.</p>
                <Button className="mt-3" size="sm" onClick={() => setCreateOpen(true)}>
                  New workflow
                </Button>
              </div>
            )}
            {runs.map((item) => {
              const activity = exactAndRelativeTime(item.updatedAt);
              return (
                <button
                  className={`block w-full rounded border p-3 text-left ${selected === item.id ? "bg-muted" : ""}`}
                  key={item.id}
                  onClick={() => setSelected(item.id, item.squadronId)}
                >
                  <strong className="line-clamp-2">{item.title}</strong>
                  <span className="mt-2 block">
                    <Status status={item.status} />
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {phaseLabel(item.phase)} ·{" "}
                    <Tooltip>
                      <TooltipTrigger render={<time dateTime={item.updatedAt ?? undefined} />}>
                        {activity.relative}
                      </TooltipTrigger>
                      <TooltipPopup>{activity.exact}</TooltipPopup>
                    </Tooltip>
                  </span>
                </button>
              );
            })}
            <div className="flex justify-between text-sm">
              <Button
                disabled={offset === 0}
                size="sm"
                variant="ghost"
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Newer
              </Button>
              <Button
                disabled={offset + runs.length >= total}
                size="sm"
                variant="ghost"
                onClick={() => setOffset(offset + 50)}
              >
                Older
              </Button>
            </div>
          </nav>

          {!selected && (
            <section className="rounded-lg border p-8 text-center">
              <h2 className="font-semibold">Select a workflow</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Choose one from the list, or start a new workflow.
              </p>
            </section>
          )}
          {selected && !run && !readError && (
            <section className="rounded-lg border p-8 text-center">Loading workflow…</section>
          )}
          {run?.id === selected && (
            <section className="min-w-0 space-y-4">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold">
                    {record(run.inputs)
                      ? String(run.inputs.request ?? "Development workflow")
                      : "Development workflow"}
                  </h2>
                  <Status status={run.status} />
                </div>
                <p>
                  {phaseLabel(run.phase)} · {expectedNextStep(run, definition)}
                </p>
                <p className="text-sm text-muted-foreground">
                  Repository: <span className="break-all">{run.repository}</span>
                </p>
              </div>
              <Progress definition={definition} run={run} />

              {run.cause && (
                <section className="rounded-lg border border-warning p-4" role="status">
                  <h3 className="font-semibold">{failureHeading(run)}</h3>
                  <p className="mt-1 text-sm">
                    {run.recovery === "retry"
                      ? "The server can reconcile the same action identity and deadline; this does not reset its attempt budget."
                      : run.recovery === "restore_definition"
                        ? "Restore the exact pinned definition version before continuing."
                        : run.recovery === "inspect_external_result"
                          ? "Inspect the linked external work. No automatic retry is supported for this action."
                          : "Review the technical detail and retained evidence before intervening."}
                  </p>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm">Technical detail</summary>
                    <p className="mt-1 break-all text-xs">
                      {run.cause}
                      {run.relevantActionId ? ` · Action ${run.relevantActionId}` : ""}
                    </p>
                  </details>
                </section>
              )}

              {run.gate && (
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
                        : "Review plan and verification commands"}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Your decision applies only to gate revision {run.gate.revision} and the
                      evidence listed here.
                    </p>
                  </div>
                  <ReviewerSummary artifacts={gateArtifacts} />
                  {gateArtifacts
                    .filter(
                      (artifact) => !record(artifact.content) || !("verdict" in artifact.content),
                    )
                    .map((artifact) => (
                      <div key={artifact.id}>
                        <h4 className="mb-2 font-medium">
                          {phaseLabel(artifact.phase)}{" "}
                          <span className="text-xs text-muted-foreground">
                            by {artifact.producer}
                          </span>
                        </h4>
                        <ReviewDocument content={artifact.content} />
                      </div>
                    ))}
                  {publicationValidation && (
                    <details open>
                      <summary className="cursor-pointer font-medium">
                        Validation for candidate {publicationIdentity?.slice(0, 12)}
                      </summary>
                      <div className="mt-2">
                        <ReviewDocument content={publicationValidation.content} />
                      </div>
                    </details>
                  )}
                  <details>
                    <summary className="cursor-pointer font-medium">Full reviewer evidence</summary>
                    <div className="mt-3 space-y-3">
                      {gateArtifacts
                        .filter(
                          (artifact) => record(artifact.content) && "verdict" in artifact.content,
                        )
                        .map((artifact) => (
                          <div key={artifact.id}>
                            <h4>{phaseLabel(artifact.producer)}</h4>
                            <ReviewDocument content={artifact.content} />
                          </div>
                        ))}
                    </div>
                  </details>

                  {run.phase === "publication_approval" && (
                    <section className="space-y-3 rounded border p-3" aria-label="Publication text">
                      <h4 className="font-medium">Publication text</h4>
                      <label className="block text-sm">
                        Commit message
                        <Textarea
                          aria-label="Commit message"
                          value={metadata.commitMessage}
                          onChange={(event) => beginDraft({ commitMessage: event.target.value })}
                        />
                      </label>
                      <label className="block text-sm">
                        PR title
                        <Textarea
                          aria-label="PR title"
                          value={metadata.title}
                          onChange={(event) => beginDraft({ title: event.target.value })}
                        />
                      </label>
                      <label className="block text-sm">
                        PR body
                        <Textarea
                          aria-label="PR body"
                          value={metadata.body}
                          onChange={(event) => beginDraft({ body: event.target.value })}
                        />
                      </label>
                      <Button
                        disabled={
                          pendingAction !== null ||
                          !metadataDirty ||
                          !metadata.commitMessage.trim() ||
                          !metadata.title.trim()
                        }
                        variant="outline"
                        onClick={() =>
                          void submit(
                            "save",
                            `/${encodeURIComponent(run.id)}/metadata`,
                            {
                              ...metadata,
                              expectedRevision: run.revision,
                              gateRevision: run.gate!.revision,
                              artifactHash: run.gate!.artifactHash,
                            },
                            "Publication text saved; review the new gate version before approving",
                          )
                        }
                      >
                        {pendingAction === "save" ? actionLabel.save : "Save changes"}
                      </Button>
                      {metadataDirty ? (
                        <p className="text-sm text-warning">Save changes before approving.</p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Saved as gate revision {run.gate.revision}. Approve to publish this
                          version.
                        </p>
                      )}
                    </section>
                  )}

                  <div className="sticky bottom-0 space-y-3 rounded-md border bg-background/95 p-3 shadow-sm backdrop-blur">
                    <Textarea
                      ref={feedbackRef}
                      aria-label="Review feedback"
                      value={feedbackText}
                      onChange={(event) =>
                        setFeedback({
                          runId: run.id,
                          gateHash: run.gate!.artifactHash,
                          text: event.target.value,
                        })
                      }
                      placeholder={`Feedback sent to ${run.phase === "publication_approval" ? "implementation" : "plan revision"}`}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={pendingAction !== null || Boolean(metadataDirty)}
                        title={metadataDirty ? "Save changes before approving" : undefined}
                        onClick={() => decide("approve")}
                      >
                        {pendingAction === "approve"
                          ? actionLabel.approve
                          : run.phase === "publication_approval"
                            ? "Approve and publish"
                            : "Approve plan"}
                      </Button>
                      <Button
                        disabled={pendingAction !== null}
                        variant="outline"
                        onClick={() => {
                          if (!feedbackText.trim()) {
                            setMutationError("Describe the requested change before sending it.");
                            feedbackRef.current?.focus();
                            return;
                          }
                          decide("request_changes");
                        }}
                      >
                        {pendingAction === "request_changes"
                          ? actionLabel.request_changes
                          : "Request changes"}
                      </Button>
                      <Button variant="ghost" onClick={() => feedbackRef.current?.focus()}>
                        Add feedback
                      </Button>
                    </div>
                  </div>
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Technical gate identity
                    </summary>
                    <p className="break-all text-xs">
                      Revision {run.gate.revision} · {run.gate.artifactHash}
                    </p>
                  </details>
                </section>
              )}

              {run.status === "blocked" &&
                ["retry", "restore_definition"].includes(run.recovery ?? "") && (
                  <Button
                    disabled={pendingAction !== null}
                    onClick={() =>
                      void submit(
                        "recover",
                        `/${encodeURIComponent(run.id)}/retry`,
                        { expectedRevision: run.revision },
                        run.recovery === "retry"
                          ? "Reconciliation requested"
                          : "Definition recovery requested",
                      )
                    }
                  >
                    {pendingAction === "recover"
                      ? actionLabel.recover
                      : run.recovery === "retry"
                        ? "Reconcile action"
                        : "Check restored definition"}
                  </Button>
                )}

              {["running", "waiting_approval", "blocked"].includes(run.status) && (
                <div className="rounded-lg border border-destructive/30 p-4">
                  <h3 className="font-medium">Stop workflow</h3>
                  <p className="mb-3 text-sm text-muted-foreground">
                    Stops successor work and interrupts owned work. Artifacts, worktrees, and
                    completed publication results are retained.
                  </p>
                  <Button
                    disabled={pendingAction !== null}
                    variant="destructive"
                    onClick={() => setCancelOpen(true)}
                  >
                    Cancel workflow
                  </Button>
                </div>
              )}

              <Result run={run} />
              <details
                className="rounded-lg border p-4"
                open={run.actions.some((action) =>
                  ["pending", "claimed", "blocked"].includes(action.status),
                )}
              >
                <summary className="cursor-pointer font-semibold">
                  Current activity and history
                </summary>
                <div className="mt-3 space-y-4">
                  {[...new Set(run.actions.map((action) => action.phase))].map((phase) => (
                    <section key={phase}>
                      <h4 className="font-medium">{phaseLabel(phase)}</h4>
                      <ul className="text-sm">
                        {run.actions
                          .filter((action) => action.phase === phase)
                          .map((action) => (
                            <li className="py-1" key={action.id}>
                              {action.task} · attempt {action.attempt} · {phaseLabel(action.status)}
                              {["pending", "claimed"].includes(action.status) && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  · deadline{" "}
                                  <time dateTime={new Date(action.deadline).toISOString()}>
                                    {new Date(action.deadline).toLocaleString()}
                                  </time>
                                </span>
                              )}
                              {action.externalIdentity && environmentId && (
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
                              )}
                            </li>
                          ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </details>
              <details className="rounded-lg border p-4">
                <summary className="cursor-pointer font-semibold">
                  Previous revisions and artifacts
                </summary>
                <div className="mt-3 space-y-3">
                  {run.artifacts
                    .filter((artifact) => !run.gate?.artifactIds.includes(artifact.id))
                    .map((artifact) => (
                      <details className="rounded border p-3" key={artifact.id}>
                        <summary>
                          {phaseLabel(artifact.phase)} · {artifact.producer} · artifact revision{" "}
                          {artifact.revision}
                        </summary>
                        <ReviewDocument content={artifact.content} />
                      </details>
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
                      className="text-sm"
                      key={`${approval.gateRevision}:${approval.artifactHash}:${approval.actor}:${approval.decision}`}
                    >
                      {approval.actor}: {phaseLabel(approval.decision)} · gate{" "}
                      {approval.gateRevision}
                      {approval.feedback && ` — ${approval.feedback}`}
                    </li>
                  ))}
                </ul>
              </section>
            </section>
          )}
        </div>
      </main>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>New workflow</DialogTitle>
            <DialogDescription>
              Start a deterministic development workflow in a Squadron with exactly one project.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {eligibleSquadrons.length ? (
              <label className="block text-sm">
                Squadron
                <select
                  aria-label="Workflow Squadron"
                  className="mt-1 block w-full rounded border bg-background p-2"
                  value={createSquadron}
                  onChange={(event) => setCreateSquadron(event.target.value)}
                >
                  {eligibleSquadrons.map((item) => (
                    <option key={item.squadron.id} value={item.squadron.id}>
                      {item.squadron.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="rounded border p-3 text-sm">
                No eligible Squadron has exactly one project. Create or update a Squadron before
                starting a workflow.
              </p>
            )}
            {squadrons.some((item) => item.projectIds.length !== 1) && (
              <details className="text-sm text-muted-foreground">
                <summary>Why are some Squadrons unavailable?</summary>
                <ul className="mt-2 list-disc ps-5">
                  {squadrons
                    .filter((item) => item.projectIds.length !== 1)
                    .map((item) => (
                      <li key={item.squadron.id}>
                        {item.squadron.name}:{" "}
                        {item.projectIds.length === 0
                          ? "no project"
                          : `${item.projectIds.length} projects`}
                      </li>
                    ))}
                </ul>
              </details>
            )}
            <label className="block text-sm">
              Base ref
              <Input
                aria-label="Base ref"
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Development request
              <Textarea
                aria-label="Development request"
                className="mt-1 min-h-32"
                placeholder="Describe the change and acceptance criteria"
                value={request}
                onChange={(event) => setRequest(event.target.value)}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              disabled={pendingAction !== null || !createSquadron || !request.trim()}
              onClick={() =>
                void submit(
                  "start",
                  "",
                  {
                    definitionId: "fh-development",
                    squadronId: createSquadron,
                    expectedRevision: 0,
                    request,
                    baseRef,
                    evidence: [],
                  },
                  "Workflow accepted; automated work is starting",
                )
              }
            >
              {pendingAction === "start" ? actionLabel.start : "Start workflow"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
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
                setCancelOpen(false);
                if (!run) return;
                if (run.gate) decide("cancel");
                else
                  void submit(
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
    </SidebarInset>
  );
}

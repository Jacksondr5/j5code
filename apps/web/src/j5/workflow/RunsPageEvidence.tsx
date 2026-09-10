import type {
  Artifact,
  ArtifactMetadata,
  RunDetail,
  WorkflowDefinitionPresentation,
} from "@j5/workflow-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { lazy, Suspense, useState } from "react";

import { useWorkflowQuery, workflowArtifactAtom } from "./queries";
import { expectedNextStep, phaseLabel, statusPresentation } from "./presentation";
import { PhaseStrip, phaseStripModel } from "./phaseStrip";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const ReviewDocument = lazy(() =>
  import("./ReviewDocument").then(({ ReviewDocument: component }) => ({ default: component })),
);

export function EvidenceDocument({ content }: { readonly content: unknown }) {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading evidence…</p>}>
      <ReviewDocument content={content} />
    </Suspense>
  );
}

export function Status({ status }: { status: RunDetail["status"] }) {
  const presentation = statusPresentation[status];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium">
      <span aria-hidden>{presentation.marker}</span>
      {presentation.label}
    </span>
  );
}

export function ReviewerSummary({ artifacts }: { artifacts: readonly Artifact[] }) {
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

export function Progress({
  run,
  definition,
}: {
  run: RunDetail;
  definition: WorkflowDefinitionPresentation | undefined;
}) {
  const current = definition?.phases.findIndex((phase) => phase.id === run.phase) ?? -1;
  const currentPhase = definition?.phases[current];
  const visits = run.visits[run.phase] ?? 0;
  const strip = definition
    ? phaseStripModel(definition.phases, run.visits, run.phase, run.status)
    : null;
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
            {strip?.cells.map((phase, index) => {
              return (
                <li
                  className={`rounded border p-2 ${phase.state === "current" || phase.state === "blocked" ? "border-primary" : ""}`}
                  key={phase.id}
                >
                  {index + 1}. {phase.label} {phase.kind === "gate" && "· Human gate"}
                  <span className="block text-xs text-muted-foreground">
                    {phase.visits
                      ? `Visited ${phase.visits} time${phase.visits === 1 ? "" : "s"}; current validity depends on later transitions.`
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
      {definition ? (
        <div className="mt-3">
          <PhaseStrip
            currentPhase={run.phase}
            phases={definition.phases}
            status={run.status}
            visits={run.visits}
          />
        </div>
      ) : null}
    </section>
  );
}

export function Result({ artifacts }: { artifacts: readonly Artifact[] }) {
  const commit = artifacts.findLast((artifact) => artifact.phase === "commit");
  const push = artifacts.findLast((artifact) => artifact.phase === "push");
  const draft = artifacts.findLast((artifact) => artifact.phase === "draft");
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

export function LazyArtifact({
  environmentId,
  runId,
  artifact,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
  readonly artifact: ArtifactMetadata;
}) {
  const [open, setOpen] = useState(false);
  const query = useWorkflowQuery(
    open ? workflowArtifactAtom({ environmentId, input: { runId, artifact } }) : null,
  );
  return (
    <details className="rounded border p-3" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {phaseLabel(artifact.phase)} · {artifact.producer} · artifact revision {artifact.revision}
      </summary>
      {open && query.data ? <EvidenceDocument content={query.data.content} /> : null}
      {open && query.error ? <p role="alert">{query.error}</p> : null}
    </details>
  );
}

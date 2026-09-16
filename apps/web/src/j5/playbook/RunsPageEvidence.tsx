import type {
  Artifact,
  ArtifactMetadata,
  RunDetail,
  PlaybookDefinitionPresentation,
} from "@j5/playbook-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { lazy, Suspense, useState } from "react";

import { usePlaybookQuery, playbookArtifactAtom } from "./queries";
import { Badge } from "../../components/ui/badge";
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

export function Status({ status, label }: { status: RunDetail["status"]; label?: string }) {
  const presentation = statusPresentation[status];
  return (
    <Badge size="sm" variant={presentation.variant} className="gap-1 font-medium tracking-tight">
      <span aria-hidden className="text-[10px] leading-none opacity-80">
        {presentation.marker}
      </span>
      {label ?? presentation.label}
    </Badge>
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
  definition: PlaybookDefinitionPresentation | undefined;
}) {
  const current = definition?.phases.findIndex((phase) => phase.id === run.phase) ?? -1;
  const currentPhase = definition?.phases[current];
  const visits = run.visits[run.phase] ?? 0;
  const strip = definition
    ? phaseStripModel(definition.phases, run.visits, run.phase, run.status)
    : null;
  return (
    <section className="rounded-lg border p-4" aria-label="Playbook progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">{phaseLabel(run.phase)}</h3>
          <p className="text-sm text-muted-foreground">{expectedNextStep(run, definition)}</p>
        </div>
        {currentPhase && currentPhase.maxVisits > 1 && (
          <span className="text-sm">
            Attempt {visits} of {currentPhase.maxVisits}
          </span>
        )}
      </div>
      {definition ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">
            All {definition.phases.length} phases
          </summary>
          <ol className="mt-3 flex flex-wrap gap-2 text-xs">
            {strip?.cells.map((phase, index) => {
              return (
                <li
                  className={`rounded border px-2 py-1.5 ${phase.state === "current" || phase.state === "blocked" ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground"}`}
                  key={phase.id}
                >
                  {index + 1}. {phase.label} {phase.kind === "gate" && "· Human gate"}
                  <span className="block text-xs text-muted-foreground">
                    {phase.state === "current"
                      ? "Current"
                      : phase.state === "blocked"
                        ? "Blocked"
                        : phase.visits
                          ? `Visited ${phase.visits}×`
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

export function Result({
  artifacts,
  publication,
}: {
  artifacts: readonly Artifact[];
  publication?: PlaybookDefinitionPresentation["publication"];
}) {
  const commit = artifacts.findLast(
    (artifact) => artifact.phase === (publication?.commit ?? "commit"),
  );
  const push = artifacts.findLast((artifact) => artifact.phase === (publication?.push ?? "push"));
  const draft = artifacts.findLast(
    (artifact) => artifact.phase === (publication?.draft ?? "draft"),
  );
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
  const query = usePlaybookQuery(
    open ? playbookArtifactAtom({ environmentId, input: { runId, artifact } }) : null,
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

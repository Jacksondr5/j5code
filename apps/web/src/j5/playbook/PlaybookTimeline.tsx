import type { TimelinePage } from "@j5/playbook-contracts/observability";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { phaseLabel } from "./presentation";
import { usePlaybookQuery, playbookTimelineAtom } from "./queries";
import {
  detectDissent,
  flattenTimeline,
  groupTimelinePhases,
  type TimelineDisplayEntry,
} from "./timelineModel";

const eventLabel = (entry: TimelineDisplayEntry) => {
  const name =
    entry.kind === "gate_opened"
      ? "Approval requested"
      : entry.kind === "gate_revised"
        ? "Approval updated"
        : entry.kind === "action_queued"
          ? "Queued"
          : entry.kind === "action_completed"
            ? "Finished"
            : entry.kind === "action_failed"
              ? "Failed"
              : entry.kind === "phase_entered"
                ? "Phase entered"
                : phaseLabel(entry.kind);
  const detail =
    entry.task ?? entry.decision ?? entry.failureCategory ?? entry.cause ?? entry.eventType;
  return detail ? `${name} · ${phaseLabel(detail)}` : name;
};

interface PlaybookTimelineProps {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
  readonly layout?: "wide" | "stacked" | undefined;
}

export function PlaybookTimeline(props: PlaybookTimelineProps) {
  return <PlaybookTimelineForRun {...props} key={props.runId} />;
}

function PlaybookTimelineForRun({ environmentId, runId, layout = "wide" }: PlaybookTimelineProps) {
  const [before, setBefore] = useState<number | null>(null);
  const [olderPages, setOlderPages] = useState<readonly TimelinePage[]>([]);
  const head = usePlaybookQuery(
    playbookTimelineAtom({ environmentId, input: { runId, before: null } }),
  );
  const older = usePlaybookQuery(
    before === null ? null : playbookTimelineAtom({ environmentId, input: { runId, before } }),
  );
  const currentOlder =
    before !== null &&
    older.data?.runId === runId &&
    older.data.revisions.every((revision) => revision.revision < before)
      ? older.data
      : null;
  const pages = useMemo(
    () => [head.data, ...olderPages, currentOlder].filter((page) => page != null),
    [currentOlder, head.data, olderPages],
  );
  const entries = useMemo(() => flattenTimeline(pages), [pages]);
  const groups = useMemo(() => groupTimelinePhases(entries), [entries]);
  const dissent = useMemo(() => detectDissent(entries), [entries]);
  const nextBefore = before === null ? head.data?.nextBefore : currentOlder?.nextBefore;

  if (head.error)
    return (
      <p role="alert" className="rounded border border-destructive p-4">
        Timeline unavailable: {head.error}
      </p>
    );
  if (!head.data) return <p className="rounded border p-4">Loading playbook timeline…</p>;
  return (
    <section aria-label="Playbook timeline" className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Playbook activity</h3>
        <span className="text-xs text-muted-foreground">
          Newest first · {entries.length} recorded events loaded
        </span>
      </header>
      {entries.some((entry) => entry.partial) ? (
        <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
          Some imported history is incomplete. Events stay in recorded order; unavailable times are
          not estimated.
        </p>
      ) : null}
      {dissent.map((item) => (
        <div className="rounded border border-warning p-3 text-sm" key={item.gateRevision}>
          <strong>Reviewer dissent:</strong> {item.reviewers.join(", ")} requested revision in{" "}
          {phaseLabel(item.phase ?? "review")}.
          {item.overriddenBy ? ` Later approved by ${item.overriddenBy}.` : ""}
        </div>
      ))}
      {!entries.length ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          No recorded activity yet.
        </p>
      ) : null}
      <div className="space-y-3">
        {groups.map((group) => (
          <section
            className={
              layout === "wide"
                ? "grid min-w-0 gap-3 rounded-lg border p-4 lg:grid-cols-[9rem_minmax(0,1fr)]"
                : "min-w-0 space-y-3 rounded-lg border p-3"
            }
            key={group.id}
          >
            <header>
              <h4 className="text-sm font-semibold">
                {group.phase ? phaseLabel(group.phase) : "Playbook"}
              </h4>
              <p className="mt-1 text-xs text-muted-foreground">
                {group.visit === null ? "Visit unavailable" : `Visit ${group.visit}`}
              </p>
            </header>
            <ol className="min-w-0 space-y-2">
              {group.entries.map((entry) => {
                const isGate = ["gate_opened", "gate_revised", "decision"].includes(entry.kind);
                return (
                  <li
                    className={`min-w-0 rounded-md border-l-2 px-3 py-2 text-sm ${isGate ? "border-primary bg-primary/5" : "border-border bg-muted/20"}`}
                    key={entry.id}
                  >
                    <details>
                      <summary className="cursor-pointer break-words">
                        <span className="font-medium">{eventLabel(entry)}</span>
                        {entry.attempt !== undefined ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            Attempt {entry.attempt}
                          </span>
                        ) : null}
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {entry.partial || entry.recordedAt === null
                            ? "Time unavailable"
                            : new Date(entry.recordedAt).toLocaleString()}
                        </span>
                      </summary>
                      <div className="mt-3 space-y-1 border-t pt-2 text-xs text-muted-foreground">
                        <div>Revision {entry.revision}</div>
                        {entry.actor ? <div>Decision by {entry.actor}</div> : null}
                        {entry.gateRevision !== undefined ? (
                          <div>Approval revision {entry.gateRevision}</div>
                        ) : null}
                        {entry.fromPhase ? (
                          <div>
                            From {phaseLabel(entry.fromPhase)}
                            {entry.fromVisit ? ` · visit ${entry.fromVisit}` : ""}
                          </div>
                        ) : null}
                        {entry.cause ? (
                          <div className="whitespace-pre-wrap break-words">{entry.cause}</div>
                        ) : null}
                        {entry.actionId ? (
                          <div className="break-all">Action {entry.actionId}</div>
                        ) : null}
                      </div>
                    </details>
                    {entry.verdict ? (
                      <p className="mt-1 text-xs font-medium">
                        Review: {phaseLabel(entry.verdict)}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
      {older.error ? <p role="alert">Could not load older events: {older.error}</p> : null}
      {nextBefore !== null && nextBefore !== undefined ? (
        <Button
          disabled={before !== null && !currentOlder}
          variant="outline"
          onClick={() => {
            if (before !== null && currentOlder)
              setOlderPages((current) => [...current, currentOlder]);
            setBefore(nextBefore);
          }}
        >
          {before !== null && !currentOlder ? "Loading…" : "Load older"}
        </Button>
      ) : null}
    </section>
  );
}

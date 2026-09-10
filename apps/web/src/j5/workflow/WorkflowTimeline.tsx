import type { TimelinePage } from "@j5/workflow-contracts/observability";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { phaseLabel } from "./presentation";
import { useWorkflowQuery, workflowTimelineAtom } from "./queries";
import {
  detectDissent,
  flattenTimeline,
  groupTimelineLanes,
  type TimelineDisplayEntry,
} from "./timelineModel";

const eventLabel = (entry: TimelineDisplayEntry) => {
  const name = entry.kind.replaceAll("_", " ");
  const detail =
    entry.task ??
    entry.phase ??
    entry.decision ??
    entry.failureCategory ??
    entry.cause ??
    entry.eventType;
  return detail ? `${name} · ${phaseLabel(detail)}` : name;
};

interface WorkflowTimelineProps {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
  readonly layout?: "wide" | "stacked" | undefined;
}

export function WorkflowTimeline(props: WorkflowTimelineProps) {
  return <WorkflowTimelineForRun {...props} key={props.runId} />;
}

function WorkflowTimelineForRun({ environmentId, runId, layout = "wide" }: WorkflowTimelineProps) {
  const [before, setBefore] = useState<number | null>(null);
  const [olderPages, setOlderPages] = useState<readonly TimelinePage[]>([]);
  const head = useWorkflowQuery(
    workflowTimelineAtom({ environmentId, input: { runId, before: null } }),
  );
  const older = useWorkflowQuery(
    before === null ? null : workflowTimelineAtom({ environmentId, input: { runId, before } }),
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
  const lanes = useMemo(() => groupTimelineLanes(entries), [entries]);
  const dissent = useMemo(() => detectDissent(entries), [entries]);
  const nextBefore = before === null ? head.data?.nextBefore : currentOlder?.nextBefore;

  if (head.error)
    return (
      <p role="alert" className="rounded border border-destructive p-4">
        Timeline unavailable: {head.error}
      </p>
    );
  if (!head.data) return <p className="rounded border p-4">Loading workflow timeline…</p>;
  return (
    <section aria-label="Workflow timeline" className="space-y-4">
      {dissent.map((item) => (
        <div className="rounded border border-warning p-3 text-sm" key={item.gateRevision}>
          <strong>Reviewer dissent:</strong> {item.reviewers.join(", ")} requested revision in{" "}
          {phaseLabel(item.phase ?? "review")}.
          {item.overriddenBy ? ` Later approved by ${item.overriddenBy}.` : ""}
        </div>
      ))}
      <div className={layout === "wide" ? "grid gap-4 lg:grid-cols-4" : "space-y-4"}>
        {lanes.map((lane) => (
          <section className="min-w-0 rounded-lg border p-3" key={`${lane.lane}:${lane.label}`}>
            <h3 className="font-semibold">{lane.label}</h3>
            <ol className="mt-3 space-y-3">
              {lane.entries.map((entry) => (
                <li className="border-l-2 pl-3 text-sm" key={entry.id}>
                  <div className="font-medium capitalize">{eventLabel(entry)}</div>
                  <div className="text-xs text-muted-foreground">
                    Revision {entry.revision} ·{" "}
                    {entry.partial || entry.recordedAt === null
                      ? "time unavailable"
                      : new Date(entry.recordedAt).toLocaleString()}
                  </div>
                  {entry.verdict ? (
                    <div className="text-xs text-muted-foreground">Verdict: {entry.verdict}</div>
                  ) : null}
                </li>
              ))}
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

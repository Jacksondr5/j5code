import { presentPlaybook } from "@t3tools/client-runtime/j5/playbooks";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { j5Environment } from "../state";

/** The visible thread owns this bounded live read; hidden tabs do no polling. */
export function PlaybookBoard(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const query = useEnvironmentQuery(
    j5Environment.playbooks({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { isPending, refresh: refreshQuery } = query;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = () => {
      if (!isPending) refreshQuery();
    };
    const sync = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        timer = setInterval(refresh, 2_500);
      }
    };
    const onVisible = () => {
      sync();
      if (document.visibilityState === "visible") refresh();
    };
    sync();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshQuery, isPending]);
  const runs = query.data?.runs ?? [];
  const run = runs.find((entry) => entry.runId === selectedRunId) ?? runs[0];
  if (!run) return null;
  const display = presentPlaybook(run);
  return (
    <section
      aria-label="Playbook progress"
      className="shrink-0 border-b border-border bg-card px-4 py-3"
    >
      <details open key={`${props.environmentId}:${props.threadId}:${run.runId}`}>
        <summary className="cursor-pointer text-sm">
          <span className="font-medium">{run.title}</span>
          <span className="ml-3 text-muted-foreground">
            {display.status} · {display.position} · {display.currentTitle}
          </span>
        </summary>
        {runs.length > 1 && (
          <label className="mt-2 block text-xs text-muted-foreground">
            Run{" "}
            <select
              aria-label="Playbook run"
              value={run.runId}
              onChange={(event) => setSelectedRunId(event.target.value)}
              className="ml-2 rounded border border-border bg-background p-1 text-foreground"
            >
              {runs.map((entry, index) => (
                <option key={entry.runId} value={entry.runId}>
                  {index === 0 ? "Latest: " : ""}
                  {entry.title} · {entry.status} · {new Date(entry.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        )}
        {run.description && <p className="mt-2 text-xs text-muted-foreground">{run.description}</p>}
        {query.error && (
          <p role="status" className="mt-2 text-xs text-amber-600">
            Progress could not refresh. Showing the last received state.
          </p>
        )}
        {run.issue && (
          <p role="status" className="mt-2 text-xs text-amber-600">
            {run.issue.message}
          </p>
        )}
        <ol className="mt-3 flex gap-3 overflow-x-auto pb-1" aria-label="Playbook phases">
          {display.steps.map((step, index) => (
            <li
              key={step.id}
              aria-current={step.current ? "step" : undefined}
              className={`min-w-40 flex-1 rounded-lg border p-3 ${step.current ? "border-primary bg-primary/5" : "border-border bg-background"}`}
            >
              <div className="mb-1 flex justify-between gap-3 text-xs text-muted-foreground">
                <span>{index + 1}</span>
                <span>{step.label}</span>
              </div>
              <p className="text-sm font-medium">{step.title}</p>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

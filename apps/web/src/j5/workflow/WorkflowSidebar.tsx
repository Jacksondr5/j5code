import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { WorkflowEntry } from "@j5/workflow-contracts/sidebar";
import { useSquadronAmbientScope } from "../squadron/SquadronDraftState";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { listWorkflowEntries } from "./client";
import { exactAndRelativeTime, phaseLabel, statusPresentation } from "./presentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import "./workflow.css";

export function WorkflowSidebar({ query = "" }: { query?: string }) {
  const squadronId = useSquadronAmbientScope() ?? "";
  const environmentId = usePrimaryEnvironmentId();
  const [result, setResult] = useState<{
    key: string;
    runs: readonly WorkflowEntry[];
    hasMore: boolean;
  } | null>(null);
  const [error, setError] = useState(false);
  const key = `${environmentId}:${squadronId}:${query}`;
  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await listWorkflowEntries(squadronId, query, 0, 20);
        if (active) {
          setResult({ key, ...next });
          setError(false);
        }
      } catch {
        if (active) setError(true);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    const reconnect = () => void refresh();
    for (const event of ["online", "focus", "j5-workflows-changed"])
      window.addEventListener(event, reconnect);
    return () => {
      active = false;
      window.clearInterval(timer);
      for (const event of ["online", "focus", "j5-workflows-changed"])
        window.removeEventListener(event, reconnect);
    };
  }, [squadronId, query, key]);
  const runs = result?.key === key ? result.runs : [];
  return (
    <section aria-label="Workflows" className="space-y-1 border-b px-2 py-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Workflows</span>
        <Link
          to="/runs"
          search={{ runId: undefined, squadronId: squadronId || undefined, newWorkflow: true }}
        >
          New workflow
        </Link>
      </div>
      {error && (
        <p role="status" className="text-xs">
          Workflow updates unavailable. Reconnecting…
        </p>
      )}
      {runs.map((run) => (
        <Link
          key={run.id}
          to="/runs"
          search={{ runId: run.id, squadronId: run.squadronId, newWorkflow: undefined }}
          hash={run.status === "waiting_approval" ? "workflow-approval" : ""}
          hashScrollIntoView={{ block: "start", behavior: "instant" }}
          onClick={() => {
            const target = document.getElementById("workflow-approval");
            if (run.status === "waiting_approval" && target?.dataset.workflowRunId === run.id) {
              target.scrollIntoView({ block: "start", behavior: "instant" });
            }
          }}
          title={run.title}
          className="block rounded-md border border-transparent px-2 py-2 hover:bg-sidebar-accent"
          activeProps={{ className: "bg-sidebar-accent border-sidebar-border" }}
          activeOptions={{ exact: true, includeSearch: true }}
        >
          <span className="line-clamp-2 text-sm font-medium">{run.title}</span>
          <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span
              key={run.gateRevision}
              className={
                run.status === "waiting_approval"
                  ? "j5-workflow-approval whitespace-nowrap font-medium text-amber-700 dark:text-amber-300"
                  : "whitespace-nowrap"
              }
              role="status"
            >
              <span aria-hidden>{statusPresentation[run.status].marker}</span>{" "}
              {statusPresentation[run.status].label}
            </span>
            <span>{phaseLabel(run.phase)}</span>
          </span>
          <Tooltip>
            <TooltipTrigger
              render={<span className="block text-[0.65rem] text-muted-foreground" />}
            >
              {exactAndRelativeTime(run.updatedAt).relative}
            </TooltipTrigger>
            <TooltipPopup>{exactAndRelativeTime(run.updatedAt).exact}</TooltipPopup>
          </Tooltip>
        </Link>
      ))}
      {!error && !runs.length && (
        <p className="py-2 text-xs text-muted-foreground">
          {query ? "No matching workflows" : "No workflows yet"}
        </p>
      )}
      <Link
        className="block pt-1 text-xs underline"
        to="/runs"
        search={{ runId: undefined, squadronId: undefined, newWorkflow: undefined }}
      >
        All workflows{result?.key === key && result.hasMore ? "…" : ""}
      </Link>
    </section>
  );
}

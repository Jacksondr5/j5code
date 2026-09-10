import { isWorkflowThread, type WorkflowThreadParent } from "@j5/workflow-contracts/sidebar";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { readWorkflowThreadParent } from "./client";

export function WorkflowThreadBanner({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const [parent, setParent] = useState<WorkflowThreadParent | null>(null);
  useEffect(() => {
    let active = true;
    if (!isWorkflowThread(threadId)) return;
    void readWorkflowThreadParent(threadId)
      .then((result) => {
        if (active) setParent(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [threadId]);
  if (!parent) return null;
  return (
    <aside className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-4 py-2 text-sm">
      <span>
        Part of workflow <strong>{parent.title}</strong>
      </span>
      <Link
        className="underline"
        to="/runs"
        search={{ runId: parent.runId, squadronId: parent.squadronId, newWorkflow: undefined }}
        hash="workflow-approval"
      >
        Open workflow
      </Link>
      <span className="sr-only">Environment {environmentId}</span>
    </aside>
  );
}

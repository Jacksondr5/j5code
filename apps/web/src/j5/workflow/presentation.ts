import type { Run, WorkflowDefinitionPresentation } from "@j5/workflow-contracts";

export const statusPresentation = {
  running: { label: "Running", marker: "▶" },
  waiting_approval: { label: "Needs approval", marker: "!" },
  blocked: { label: "Blocked", marker: "■" },
  failed: { label: "Failed", marker: "×" },
  cancelling: { label: "Cancelling", marker: "…" },
  cancelled: { label: "Cancelled", marker: "—" },
  completed: { label: "Completed", marker: "✓" },
} satisfies Record<Run["status"], { label: string; marker: string }>;

export const phaseLabel = (phase: string) =>
  phase.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());

export function expectedNextStep(run: Run, definition?: WorkflowDefinitionPresentation) {
  if (run.status === "waiting_approval") return "Waiting for your decision";
  if (run.status === "blocked") {
    if (run.recovery === "retry") return "Reconcile the interrupted action";
    if (run.recovery === "restore_definition") return "Restore the pinned definition";
    if (run.recovery === "inspect_external_result") return "Inspect the external result";
    return "Human intervention required";
  }
  if (run.status === "cancelling") return "Stopping owned work";
  if (["completed", "cancelled", "failed"].includes(run.status)) return "No further automated work";
  const phase = definition?.phases.find((item) => item.id === run.phase);
  if (!phase) return "Progress details unavailable for this pinned definition";
  const targets = [...new Set(Object.values(phase.transitions))];
  if (targets.length === 1)
    return targets[0] === "$complete"
      ? "Complete the workflow"
      : `Continue to ${phaseLabel(targets[0]!)}`;
  return `Next phase depends on the outcome: ${targets.map((item) => (item === "$complete" ? "Complete" : phaseLabel(item))).join(" or ")}`;
}

export function failureHeading(run: Run) {
  switch (run.failureCategory) {
    case "action_deadline_expired":
      return "Action deadline elapsed";
    case "invalid_action_output":
      return "Action returned invalid evidence";
    case "revision_budget_exhausted":
      return "Revision budget exhausted";
    case "missing_gate_evidence":
      return "Approval evidence is incomplete";
    case "definition_mismatch":
      return "Pinned definition is unavailable";
    case "candidate_changed":
      return "Candidate changed during review";
    case "transition_unavailable":
      return "Workflow cannot continue from this outcome";
    case "action_failed":
      return "Workflow action needs attention";
    default:
      return "Workflow is blocked";
  }
}

export function exactAndRelativeTime(value: string | undefined | null, now = Date.now()) {
  if (!value) return { relative: "Activity time unavailable", exact: "Unavailable" };
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { relative: "Activity time unavailable", exact: value };
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  const relative =
    minutes < 1
      ? "Active just now"
      : minutes < 60
        ? `Active ${minutes}m ago`
        : minutes < 1440
          ? `Active ${Math.floor(minutes / 60)}h ago`
          : `Active ${Math.floor(minutes / 1440)}d ago`;
  return { relative, exact: new Date(timestamp).toLocaleString() };
}

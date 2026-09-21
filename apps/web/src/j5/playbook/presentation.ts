import type { RunDetail, PlaybookDefinitionPresentation } from "@j5/playbook-contracts";

export const statusPresentation = {
  running: { label: "Running", marker: "▶", variant: "info" as const },
  restarting: { label: "Restarting review", marker: "…", variant: "warning" as const },
  waiting_approval: { label: "Needs approval", marker: "!", variant: "warning" as const },
  blocked: { label: "Blocked", marker: "■", variant: "destructive" as const },
  failed: { label: "Failed", marker: "×", variant: "error" as const },
  cancelling: { label: "Cancelling", marker: "…", variant: "secondary" as const },
  cancelled: { label: "Cancelled", marker: "—", variant: "secondary" as const },
  completed: { label: "Completed", marker: "✓", variant: "success" as const },
} satisfies Record<
  RunDetail["status"],
  {
    label: string;
    marker: string;
    variant: "default" | "secondary" | "destructive" | "warning" | "success" | "info" | "error";
  }
>;

export const phaseLabel = (phase: string) =>
  phase === "checks_approval"
    ? "Corrected checks approval"
    : phase.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());

export function expectedNextStep(run: RunDetail, definition?: PlaybookDefinitionPresentation) {
  if (run.status === "waiting_approval") return "Waiting for your decision";
  if (run.status === "blocked") {
    if (run.recovery === "resume") return "Resume playbook";
    if (run.recovery === "retry_restart") return "Retry reviewer cleanup";
    if (run.restartAvailability.available)
      return run.phase === "plan_review" ? "Restart plan review" : "Restart code review";
    if (run.recovery === "retry") return "Reconcile the interrupted action";
    if (run.recovery === "restore_definition") return "Restore the pinned definition";
    if (run.recovery === "inspect_external_result") return "Inspect the external result";
    return run.restartAvailability.reason;
  }
  if (run.status === "restarting") return "Stopping superseded reviewers";
  if (run.status === "cancelling") return "Stopping owned work";
  if (["completed", "cancelled", "failed"].includes(run.status)) return "No further automated work";
  const phase = definition?.phases.find((item) => item.id === run.phase);
  if (!phase) return "Progress details unavailable for this pinned definition";
  const targets = [...new Set(Object.values(phase.transitions))];
  const labelFor = (id: string) =>
    definition?.phases.find((item) => item.id === id)?.label ?? phaseLabel(id);
  if (targets.length === 1)
    return targets[0] === "$complete"
      ? "Complete the playbook"
      : `Continue to ${labelFor(targets[0]!)}`;
  return `Next phase depends on the outcome: ${targets.map((item) => (item === "$complete" ? "Complete" : labelFor(item))).join(" or ")}`;
}

export function failureHeading(run: RunDetail) {
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
    case "restart_cleanup_failed":
      return "Reviewer cleanup failed";
    case "server_interrupted":
      return "Interrupted";
    case "transition_unavailable":
      return "Playbook cannot continue from this outcome";
    case "action_failed":
      return "Playbook action needs attention";
    default:
      return "Playbook is blocked";
  }
}

export function exactAndRelativeTime(value: string | undefined | null, now = Date.now()) {
  return { relative: relativePlaybookTime(value, now), exact: exactPlaybookTime(value) };
}

export function relativePlaybookTime(value: string | undefined | null, now = Date.now()) {
  if (!value) return "Activity time unavailable";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Activity time unavailable";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  return minutes < 1
    ? "Active just now"
    : minutes < 60
      ? `Active ${minutes}m ago`
      : minutes < 1440
        ? `Active ${Math.floor(minutes / 60)}h ago`
        : `Active ${Math.floor(minutes / 1440)}d ago`;
}

export function exactPlaybookTime(value: string | undefined | null) {
  if (!value) return "Unavailable";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

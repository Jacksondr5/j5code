import type { RunDetail, WorkflowDefinitionPresentation } from "@j5/workflow-contracts";

import { phaseLabel } from "./presentation";

export type PhaseStripState = "done" | "current" | "pending" | "revisited" | "blocked";

export interface PhaseStripCell {
  readonly id: string;
  readonly label: string;
  readonly kind: "agent" | "code" | "gate";
  readonly visits: number;
  readonly state: PhaseStripState;
}

export function phaseStripModel(
  phases: WorkflowDefinitionPresentation["phases"],
  visits: Readonly<Record<string, number>>,
  currentPhase: string,
  status: RunDetail["status"],
) {
  const cells: PhaseStripCell[] = phases.map((phase) => {
    const count = visits[phase.id] ?? 0;
    const isCurrent = phase.id === currentPhase;
    const state: PhaseStripState = isCurrent
      ? status === "blocked" || status === "failed"
        ? "blocked"
        : "current"
      : count > 1
        ? "revisited"
        : count > 0
          ? "done"
          : "pending";
    return {
      id: phase.id,
      label: phaseLabel(phase.id),
      kind: phase.kind,
      visits: count,
      state,
    };
  });
  return { cells, current: cells.find((cell) => cell.id === currentPhase) };
}

const color: Record<PhaseStripState, string> = {
  done: "bg-success/70",
  current: "bg-primary",
  pending: "bg-muted",
  revisited: "bg-warning",
  blocked: "bg-destructive",
};

export function PhaseStrip({
  phases,
  visits,
  currentPhase,
  status,
}: {
  readonly phases: WorkflowDefinitionPresentation["phases"];
  readonly visits: Readonly<Record<string, number>>;
  readonly currentPhase: string;
  readonly status: RunDetail["status"];
}) {
  const model = phaseStripModel(phases, visits, currentPhase, status);
  return (
    <ol className="flex min-w-0 gap-1" aria-label="Workflow phases">
      {model.cells.map((cell) => (
        <li
          aria-current={cell.state === "current" || cell.state === "blocked" ? "step" : undefined}
          className={`h-2 min-w-1 flex-1 rounded-sm ${color[cell.state]}`}
          key={cell.id}
        >
          <span className="sr-only">
            {cell.label}: {cell.state}
          </span>
        </li>
      ))}
    </ol>
  );
}

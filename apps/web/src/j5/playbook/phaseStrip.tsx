import type { RunDetail, PlaybookDefinitionPresentation } from "@j5/playbook-contracts";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";

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
  phases: PlaybookDefinitionPresentation["phases"],
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
      label: phase.label ?? phaseLabel(phase.id),
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
  readonly phases: PlaybookDefinitionPresentation["phases"];
  readonly visits: Readonly<Record<string, number>>;
  readonly currentPhase: string;
  readonly status: RunDetail["status"];
}) {
  const model = phaseStripModel(phases, visits, currentPhase, status);
  return (
    <div className="space-y-2">
      <ol className="flex min-w-0 gap-1" aria-label="Playbook phases">
        {model.cells.map((cell) => (
          <li
            aria-current={cell.state === "current" || cell.state === "blocked" ? "step" : undefined}
            className="min-w-1 flex-1"
            key={cell.id}
          >
            <Tooltip>
              <TooltipTrigger
                render={<span className={`block h-2 rounded-sm ${color[cell.state]}`} />}
              >
                <span className="sr-only">
                  {cell.label}: {cell.state === "done" ? "visited" : cell.state}
                </span>
              </TooltipTrigger>
              <TooltipPopup>
                {cell.label}: {cell.state === "done" ? "visited" : cell.state}
              </TooltipPopup>
            </Tooltip>
          </li>
        ))}
      </ol>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          Visited {model.cells.filter((cell) => cell.visits > 0).length} of {model.cells.length}{" "}
          phases
        </span>
        <span className="font-medium text-foreground">
          {model.current?.label ?? phaseLabel(currentPhase)}
        </span>
      </p>
    </div>
  );
}

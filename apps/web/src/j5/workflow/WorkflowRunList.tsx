import type { WorkflowEntry } from "@j5/workflow-contracts/sidebar";
import type { WorkflowDefinitionPresentation } from "@j5/workflow-contracts";
import type { BoardCard } from "@j5/workflow-contracts/observability";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { memo, useState } from "react";
import { cn } from "../../lib/utils";

import { useNowMinute } from "../../hooks/useNowMinute";
import { exactWorkflowTime, phaseLabel, relativeWorkflowTime } from "./presentation";
import { Status } from "./RunsPageEvidence";
import { PhaseStrip } from "./phaseStrip";

function RelativeWorkflowTime({ value }: { readonly value: string }) {
  useNowMinute();
  return <>{relativeWorkflowTime(value)}</>;
}

export function WorkflowTimestamp({ value }: { readonly value: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger render={<time dateTime={value} />}>
        <RelativeWorkflowTime value={value} />
      </TooltipTrigger>
      {open ? <TooltipPopup>{exactWorkflowTime(value)}</TooltipPopup> : null}
    </Tooltip>
  );
}

const WorkflowRunRow = memo(function WorkflowRunRow({
  item,
  selected,
  onSelect,
  card,
  definitions,
}: {
  readonly item: WorkflowEntry;
  readonly selected: boolean;
  readonly onSelect: (id: string, squadronId: string) => void;
  readonly card?: BoardCard | undefined;
  readonly definitions?: readonly WorkflowDefinitionPresentation[] | undefined;
}) {
  const definition = card
    ? definitions?.find(
        (item) =>
          item.id === card.definitionId &&
          item.version === card.definitionVersion &&
          item.hash === card.definitionHash,
      )
    : undefined;
  return (
    <button
      className={cn(
        "group relative block w-full rounded-xl border p-3.5 text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        selected
          ? "border-primary/60 bg-muted/60 shadow-xs"
          : "border-border/70 bg-card/40 hover:border-border hover:bg-muted/30 hover:shadow-xs",
      )}
      onClick={() => onSelect(item.id, item.squadronId)}
    >
      <div className="flex items-start justify-between gap-2">
        <strong className="line-clamp-2 text-sm font-semibold leading-snug text-foreground group-hover:text-foreground">
          {item.title}
        </strong>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Status status={item.status} />
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/70">{phaseLabel(item.phase)}</span>
        <span aria-hidden>·</span>
        <WorkflowTimestamp value={item.updatedAt} />
      </div>
      {card && definition ? (
        <span className="mt-2.5 block">
          <PhaseStrip
            currentPhase={card.phase}
            phases={definition.phases}
            status={card.status}
            visits={card.visits}
          />
        </span>
      ) : null}
      {card?.actions.length ? (
        <span className="mt-2 block truncate text-xs text-muted-foreground">
          {card.actions
            .map((action) => `${action.task} · ${action.sessionStatus ?? "waiting to launch"}`)
            .join(", ")}
        </span>
      ) : null}
    </button>
  );
});

export function WorkflowRunList({
  runs,
  total,
  offset,
  selected,
  hasError,
  onCreate,
  onOffset,
  onSelect,
  pageSize = 50,
  cards,
  definitions,
}: {
  readonly runs: readonly WorkflowEntry[];
  readonly total: number;
  readonly offset: number;
  readonly selected: string | null;
  readonly hasError: boolean;
  readonly onCreate: () => void;
  readonly onOffset: (offset: number) => void;
  readonly onSelect: (id: string, squadronId: string) => void;
  readonly pageSize?: number;
  readonly cards?: readonly BoardCard[];
  readonly definitions?: readonly WorkflowDefinitionPresentation[];
}) {
  return (
    <nav aria-label="Playbooks" className="space-y-2">
      {!hasError && runs.length === 0 && (
        <div className="rounded border p-4 text-sm">
          <p>No playbooks in this scope.</p>
          <Button className="mt-3" size="sm" onClick={onCreate}>
            New playbook
          </Button>
        </div>
      )}
      {runs.map((item) => (
        <WorkflowRunRow
          key={item.id}
          item={item}
          selected={selected === item.id}
          onSelect={onSelect}
          card={cards?.find((card) => card.id === item.id)}
          definitions={definitions}
        />
      ))}
      <div className="flex justify-between text-sm">
        <Button
          disabled={offset === 0}
          size="sm"
          variant="ghost"
          onClick={() => onOffset(Math.max(0, offset - pageSize))}
        >
          Newer
        </Button>
        <Button
          disabled={offset + runs.length >= total}
          size="sm"
          variant="ghost"
          onClick={() => onOffset(offset + pageSize)}
        >
          Older
        </Button>
      </div>
    </nav>
  );
}

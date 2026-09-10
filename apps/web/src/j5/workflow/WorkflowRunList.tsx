import type { WorkflowEntry } from "@j5/workflow-contracts/sidebar";
import type { WorkflowDefinitionPresentation } from "@j5/workflow-contracts";
import type { BoardCard } from "@j5/workflow-contracts/observability";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { memo, useState } from "react";

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
      className={`block w-full rounded border p-3 text-left ${selected ? "bg-muted" : ""}`}
      onClick={() => onSelect(item.id, item.squadronId)}
    >
      <strong className="line-clamp-2">{item.title}</strong>
      <span className="mt-2 block">
        <Status status={item.status} />
      </span>
      <span className="mt-1 block text-xs text-muted-foreground">
        {phaseLabel(item.phase)} · <WorkflowTimestamp value={item.updatedAt} />
      </span>
      {card && definition ? (
        <span className="mt-2 block">
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
    <nav aria-label="Workflows" className="space-y-2">
      {!hasError && runs.length === 0 && (
        <div className="rounded border p-4 text-sm">
          <p>No workflows in this scope.</p>
          <Button className="mt-3" size="sm" onClick={onCreate}>
            New workflow
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

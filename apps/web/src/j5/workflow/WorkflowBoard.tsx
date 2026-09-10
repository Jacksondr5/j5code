import type { WorkflowDefinitionPresentation } from "@j5/workflow-contracts";
import type { BoardCard } from "@j5/workflow-contracts/observability";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { Button } from "../../components/ui/button";
import { PhaseStrip } from "./phaseStrip";
import { phaseLabel } from "./presentation";
import { useWorkflowQuery, workflowBoardAtom, workflowDefinitionsQuery } from "./queries";
import { Status } from "./RunsPageEvidence";
import { WorkflowTimestamp } from "./WorkflowRunList";

const matchingDefinition = (
  card: BoardCard,
  definitions: readonly WorkflowDefinitionPresentation[],
) =>
  definitions.find(
    (definition) =>
      definition.id === card.definitionId &&
      definition.version === card.definitionVersion &&
      definition.hash === card.definitionHash,
  );

export const WorkflowBoardCard = memo(function WorkflowBoardCard({
  card,
  definition,
  onSelect,
}: {
  readonly card: BoardCard;
  readonly definition: WorkflowDefinitionPresentation | undefined;
  readonly onSelect: (id: string, squadronId: string) => void;
}) {
  const currentDefinitionPhase = definition?.phases.find((phase) => phase.id === card.phase);
  return (
    <Link
      className="flex min-h-48 min-w-0 flex-col rounded-lg border p-4 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onSelect(card.id, card.squadronId);
      }}
      search={{
        runId: card.id,
        squadronId: card.squadronId,
        view: "board",
      }}
      to="/runs"
    >
      <span className="line-clamp-2 font-semibold">{card.title}</span>
      <span className="mt-2">
        <Status status={card.status} />
      </span>
      <span className="mt-2 text-sm">
        {phaseLabel(card.phase)}
        {currentDefinitionPhase && currentDefinitionPhase.maxVisits > 1
          ? ` · visit ${card.visit ?? 0}/${currentDefinitionPhase.maxVisits}`
          : ""}
      </span>
      {definition ? (
        <div className="mt-3">
          <PhaseStrip
            currentPhase={card.phase}
            phases={definition.phases}
            status={card.status}
            visits={card.visits}
          />
        </div>
      ) : null}
      {card.actions.length ? (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {card.actions.map((action) => (
            <li className="truncate" key={action.actionId}>
              {action.task} · {action.sessionStatus ?? "waiting to launch"}
            </li>
          ))}
        </ul>
      ) : null}
      <span className="mt-auto pt-3 text-xs text-muted-foreground">
        {card.gateRevision !== null ? `Gate ${card.gateRevision} · ` : ""}
        <WorkflowTimestamp value={card.updatedAt} />
      </span>
    </Link>
  );
});

export function WorkflowBoard({
  environmentId,
  squadronId,
  q,
  status,
  page,
  onPage,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly squadronId: string;
  readonly q: string;
  readonly status: string;
  readonly page: number;
  readonly onPage: (page: number) => void;
  readonly onSelect: (id: string, squadronId: string) => void;
}) {
  const board = useWorkflowQuery(
    workflowBoardAtom({
      environmentId,
      input: { squadronId, search: q, status, page, pageSize: 24 },
    }),
  );
  const definitions = useWorkflowQuery(workflowDefinitionsQuery(environmentId));
  if (board.error)
    return (
      <p role="alert" className="rounded border border-destructive p-4">
        Workflow board unavailable: {board.error}
      </p>
    );
  if (!board.data) return <p className="rounded border p-4">Loading workflow board…</p>;
  return (
    <section aria-label="Workflow board" className="space-y-4">
      {board.data.cards.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {board.data.cards.map((card) => (
            <WorkflowBoardCard
              card={card}
              definition={matchingDefinition(card, definitions.data ?? [])}
              key={card.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : (
        <p className="rounded border p-4 text-sm">No workflows in this scope.</p>
      )}
      <div className="flex items-center justify-between text-sm">
        <Button disabled={page === 0} size="sm" variant="ghost" onClick={() => onPage(page - 1)}>
          Newer
        </Button>
        <span>
          {board.data.total} {board.data.total === 1 ? "workflow" : "workflows"}
        </span>
        <Button
          disabled={!board.data.hasMore}
          size="sm"
          variant="ghost"
          onClick={() => onPage(page + 1)}
        >
          Older
        </Button>
      </div>
    </section>
  );
}

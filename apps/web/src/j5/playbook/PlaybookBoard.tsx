import type { PlaybookDefinitionPresentation } from "@j5/playbook-contracts";
import type { BoardCard } from "@j5/playbook-contracts/observability";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { Button } from "../../components/ui/button";
import { PhaseStrip } from "./phaseStrip";
import { phaseLabel } from "./presentation";
import { usePlaybookQuery, playbookBoardAtom, playbookDefinitionsQuery } from "./queries";
import { Status } from "./RunsPageEvidence";
import { PlaybookTimestamp } from "./PlaybookRunList";

const matchingDefinition = (
  card: BoardCard,
  definitions: readonly PlaybookDefinitionPresentation[],
) =>
  definitions.find(
    (definition) =>
      definition.id === card.definitionId &&
      definition.version === card.definitionVersion &&
      definition.hash === card.definitionHash,
  );

export const PlaybookBoardCard = memo(function PlaybookBoardCard({
  card,
  definition,
  onSelect,
}: {
  readonly card: BoardCard;
  readonly definition: PlaybookDefinitionPresentation | undefined;
  readonly onSelect: (id: string, squadronId: string) => void;
}) {
  const currentDefinitionPhase = definition?.phases.find((phase) => phase.id === card.phase);
  return (
    <Link
      className={`flex min-w-0 flex-col rounded-lg border p-4 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${card.status === "waiting_approval" || card.status === "blocked" ? "border-warning/60 bg-warning/5" : card.status === "running" ? "border-primary/40" : ""}`}
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
      <span className="mb-2">
        <Status status={card.status} />
      </span>
      <span className="line-clamp-2 min-w-0 text-sm font-semibold leading-relaxed [overflow-wrap:anywhere]">
        {card.title}
      </span>
      <span className="mt-2 text-sm">
        {phaseLabel(card.phase)}
        {currentDefinitionPhase && currentDefinitionPhase.maxVisits > 1
          ? ` · attempt ${card.visit ?? 0} of ${currentDefinitionPhase.maxVisits}`
          : ""}
      </span>
      {definition && !["completed", "cancelled", "failed"].includes(card.status) ? (
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
      {card.status === "waiting_approval" ? (
        <span className="mt-2 text-sm font-medium">Your decision is needed</span>
      ) : null}
      <span className="mt-auto flex items-center justify-between gap-2 pt-3 text-xs text-muted-foreground">
        <PlaybookTimestamp value={card.updatedAt} />
        <span className="shrink-0 text-foreground">View playbook →</span>
      </span>
    </Link>
  );
});

export function PlaybookBoard({
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
  const board = usePlaybookQuery(
    playbookBoardAtom({
      environmentId,
      input: { squadronId, search: q, status, page, pageSize: 24 },
    }),
  );
  const definitions = usePlaybookQuery(playbookDefinitionsQuery(environmentId));
  if (board.error)
    return (
      <p role="alert" className="rounded border border-destructive p-4">
        Playbook board unavailable: {board.error}
      </p>
    );
  if (!board.data) return <p className="rounded border p-4">Loading playbook board…</p>;
  return (
    <section aria-label="Playbook board" className="space-y-4">
      {board.data.cards.length ? (
        <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {board.data.cards.map((card) => (
            <PlaybookBoardCard
              card={card}
              definition={matchingDefinition(card, definitions.data ?? [])}
              key={card.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : (
        <p className="rounded border p-4 text-sm">No playbooks in this scope.</p>
      )}
      <div className="flex items-center justify-between text-sm">
        <Button disabled={page === 0} size="sm" variant="ghost" onClick={() => onPage(page - 1)}>
          Newer
        </Button>
        <span>
          {board.data.total} {board.data.total === 1 ? "playbook" : "playbooks"}
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

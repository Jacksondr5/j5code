import { presentAgentPersonaCatalog } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import type { CrewProposal, CrewProposalSeat } from "./crewProposalsClient";

/** Pure roster edits so the card's behavior is testable without rendering. */
export const removeSeat = (seats: ReadonlyArray<CrewProposalSeat>, seatName: string) =>
  seats.filter((seat) => seat.seat !== seatName);

export const addSeat = (
  seats: ReadonlyArray<CrewProposalSeat>,
  draft: { readonly seat: string; readonly agentId: string; readonly instructions: string },
): { readonly seats: ReadonlyArray<CrewProposalSeat>; readonly error: string | null } => {
  const seatName = draft.seat.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(seatName))
    return { seats, error: "Seat names are lowercase words joined by hyphens." };
  if (seats.some((seat) => seat.seat === seatName))
    return { seats, error: `Seat ${seatName} already exists.` };
  if (draft.agentId.length === 0) return { seats, error: "Pick an agent for the seat." };
  return {
    seats: [
      ...seats,
      {
        seat: seatName,
        agentId: draft.agentId,
        reason: "Added by the user",
        ...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
      },
    ],
    error: null,
  };
};

/** What the human is approving for a seat beyond its name: the agent and the access it runs with. */
export const describeSeatAgent = (
  rows: ReadonlyArray<{
    readonly personaId: string;
    readonly displayName: string;
    readonly authority: string;
  }>,
  agentId: string,
): { readonly name: string; readonly authority: string | null } => {
  const row = rows.find((candidate) => candidate.personaId === agentId);
  return row === undefined
    ? { name: agentId, authority: null }
    : { name: row.displayName, authority: row.authority };
};

/**
 * The human gate for one Crew request. The Captain's seats arrive with reasons; the user may drop
 * seats, add agents from the library, then approve the final roster or decline the whole request.
 */
export function CrewProposalCard(props: {
  readonly proposal: CrewProposal;
  readonly environmentId: EnvironmentId | null;
  readonly busy: boolean;
  readonly onResolve: (
    decision: "approve" | "decline",
    seats: ReadonlyArray<CrewProposalSeat>,
  ) => void;
  /** Omitted when the card already sits in the Captain's thread. */
  readonly onOpenCaptain?: (() => void) | undefined;
}) {
  const { proposal } = props;
  const [seats, setSeats] = useState<ReadonlyArray<CrewProposalSeat>>(proposal.requestedSeats);
  const [draft, setDraft] = useState({ seat: "", agentId: "", instructions: "" });
  const [error, setError] = useState<string | null>(null);
  const catalog = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const rows = useMemo(
    () =>
      catalog.data === null || catalog.data === undefined
        ? []
        : presentAgentPersonaCatalog(catalog.data),
    [catalog.data],
  );
  const agents = useMemo(() => rows.filter((agent) => agent.availability === "available"), [rows]);
  const agentName = (agentId: string) => describeSeatAgent(rows, agentId).name;

  return (
    <li
      className="rounded-lg border border-border p-4"
      data-testid={`crew-proposal-${proposal.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="warning" className="uppercase tracking-wide">
              {proposal.kind === "roster" ? "New crew" : "Add a seat"}
            </Badge>
            <span className="truncate">{proposal.captainParticipantId}</span>
          </div>
          <h2 className="mt-1 text-base font-semibold leading-snug">{proposal.displayName}</h2>
        </div>
        {props.onOpenCaptain === undefined ? null : (
          <Button size="sm" type="button" variant="ghost" onClick={props.onOpenCaptain}>
            Open Captain
          </Button>
        )}
      </div>
      <p className="mt-3 max-w-[72ch] whitespace-pre-wrap break-words text-sm text-foreground/90">
        {proposal.brief}
      </p>
      <ul className="mt-4 space-y-2">
        {seats.map((seat) => (
          <li
            key={seat.seat}
            className="flex items-start justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{seat.seat}</span>
                <Badge variant="outline">{agentName(seat.agentId)}</Badge>
                {/* Approval is the authority (2026-09-10), so the access being granted is shown. */}
                <span className="text-xs text-muted-foreground">
                  {describeSeatAgent(rows, seat.agentId).authority ?? "Access unknown"}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{seat.reason}</p>
              {seat.instructions ? (
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    Seat instructions from the Captain
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/60 p-2 font-sans text-xs leading-relaxed">
                    {seat.instructions}
                  </pre>
                </details>
              ) : null}
            </div>
            <Button
              aria-label={`Remove seat ${seat.seat}`}
              disabled={props.busy || seats.length === 1}
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={() => setSeats(removeSeat(seats, seat.seat))}
            >
              <XIcon className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_auto]">
        <Input
          aria-label="New seat name"
          disabled={props.busy}
          placeholder="seat"
          value={draft.seat}
          onChange={(event) => setDraft({ ...draft, seat: event.currentTarget.value })}
        />
        <Select
          disabled={props.busy || agents.length === 0}
          value={draft.agentId || undefined}
          onValueChange={(value) => setDraft({ ...draft, agentId: value ?? "" })}
        >
          <SelectTrigger aria-label="Agent for the new seat">
            <SelectValue>
              {draft.agentId ? agentName(draft.agentId) : "Choose an agent"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {agents.map((agent) => (
              <SelectItem key={agent.personaId} value={agent.personaId}>
                {agent.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          aria-label="Add seat"
          disabled={props.busy}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => {
            const next = addSeat(seats, draft);
            setError(next.error);
            if (next.error === null) {
              setSeats(next.seats);
              setDraft({ seat: "", agentId: "", instructions: "" });
            }
          }}
        >
          <PlusIcon className="size-4" />
          Add
        </Button>
        {/* What the new seat should do, beyond the crew's brief; the Captain's seats carry theirs. */}
        <Textarea
          aria-label="Instructions for the new seat"
          className="min-h-16 sm:col-span-3"
          disabled={props.busy}
          placeholder="Instructions for this seat (optional)"
          value={draft.instructions}
          onChange={(event) => setDraft({ ...draft, instructions: event.currentTarget.value })}
        />
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button
          disabled={props.busy}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => props.onResolve("decline", seats)}
        >
          Decline
        </Button>
        <Button
          disabled={props.busy || seats.length === 0}
          size="sm"
          type="button"
          onClick={() => props.onResolve("approve", seats)}
        >
          {props.busy
            ? "Working…"
            : `Approve ${seats.length} ${seats.length === 1 ? "seat" : "seats"}`}
        </Button>
      </div>
    </li>
  );
}

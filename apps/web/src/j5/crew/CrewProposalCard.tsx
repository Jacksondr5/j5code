import { presentAgentPersonaCatalog } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId } from "@t3tools/contracts";
import { PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import type { CrewProposal, CrewProposalSeat } from "./crewProposalsClient";
import { addSeat, describeSeatAgent, removeSeat, saveSeat } from "./crewProposalDraft";
import { CrewSeatDialog } from "./CrewSeatDialog";
import type { CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
import { useCrewProposalPreview } from "./useCrewProposalPreview";

/**
 * The human gate for one Crew request. The Captain's seats arrive with reasons; the user may drop
 * seats, add personas from the library or a custom seat with its own instructions, then approve the
 * final roster or decline the whole request.
 */
export function CrewProposalCard(props: {
  readonly proposal: CrewProposal;
  readonly environmentId: EnvironmentId | null;
  readonly busy: boolean;
  readonly onResolve: (
    decision: "approve" | "decline",
    seats: ReadonlyArray<CrewProposalSeat>,
    approvalToken?: string,
  ) => void;
  /** Omitted when the card already sits in the Captain's thread. */
  readonly onOpenCaptain?: (() => void) | undefined;
}) {
  const { proposal } = props;
  // A gate handed back after a failed launch reopens with the seats the person approved, so a
  // seat they removed stays removed and a retry sends what they last saw.
  const [seats, setSeats] = useState<ReadonlyArray<CrewProposalSeat>>(
    proposal.approvedSeats ?? proposal.requestedSeats,
  );
  const [editor, setEditor] = useState<{
    readonly seat: CrewProposalSeat | null;
    readonly runtime?: CrewProposalSeatRuntime | undefined;
  } | null>(null);
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
  const preview = useCrewProposalPreview(props.environmentId, proposal.id, seats, props.busy);

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
      <ul className="mt-4 space-y-3">
        {seats.map((seat) => {
          const runtime = preview.runtimeSeats?.find((row) => row.seat === seat.seat);
          return (
            <li key={seat.seat} className="rounded-lg border border-border/70 bg-muted/30 p-3">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-words text-sm font-medium">{seat.seat}</h3>
                    <span className="text-xs text-muted-foreground">
                      {seat.agentId === null
                        ? "Custom crew member"
                        : describeSeatAgent(rows, seat.agentId)}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-xs text-muted-foreground">{seat.reason}</p>
                </div>
                <div className="flex items-center justify-self-end gap-1">
                  <Button
                    aria-label={`Edit seat ${seat.seat}`}
                    disabled={props.busy}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setEditor({ seat, runtime })}
                  >
                    <PencilIcon className="size-3.5" />
                    Edit
                  </Button>
                  <Button
                    aria-label={`Remove seat ${seat.seat}`}
                    disabled={props.busy || seats.length === 1}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setSeats(removeSeat(seats, seat.seat))}
                  >
                    <XIcon className="size-3.5" />
                    Remove
                  </Button>
                </div>
              </div>
              {runtime ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {[runtime.provider, runtime.model, runtime.reasoning, runtime.access].join(" · ")}
                  <span className="ml-2">Harness: {runtime.harness}</span>
                </p>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground" role="status">
                  {preview.loading ? "Checking runtime…" : "Runtime unavailable"}
                </p>
              )}
              {seat.instructions ? (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Instructions</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words text-foreground/90">
                    {seat.instructions}
                  </p>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Button
        className="mt-3"
        aria-label="Add crew member"
        disabled={props.busy}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => setEditor({ seat: null })}
      >
        <PlusIcon className="size-4" />
        Add member
      </Button>
      {editor !== null ? (
        <CrewSeatDialog
          seat={editor.seat}
          runtime={editor.runtime}
          environmentId={props.environmentId}
          agents={agents}
          disabled={props.busy}
          onClose={() => setEditor(null)}
          onSave={(draft) => {
            const next =
              editor.seat === null
                ? addSeat(seats, draft)
                : saveSeat(seats, editor.seat.seat, draft);
            if (next.error === null) setSeats(next.seats);
            return next.error;
          }}
        />
      ) : null}
      {preview.error ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive" role="alert">
            {preview.error}
          </p>
          <Button
            disabled={props.busy || props.environmentId === null}
            size="sm"
            type="button"
            variant="outline"
            onClick={preview.refresh}
          >
            Refresh runtime
          </Button>
        </div>
      ) : null}
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
          disabled={props.busy || seats.length === 0 || preview.data === null}
          size="sm"
          type="button"
          onClick={() => {
            if (preview.data === null) return;
            const approvalToken = preview.data.approvalToken;
            preview.refresh();
            props.onResolve("approve", seats, approvalToken);
          }}
        >
          {props.busy
            ? "Working…"
            : preview.loading
              ? "Loading runtime…"
              : `Approve ${seats.length} ${seats.length === 1 ? "seat" : "seats"}`}
        </Button>
      </div>
    </li>
  );
}

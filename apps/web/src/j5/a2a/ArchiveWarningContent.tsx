import { InboxIcon, SendIcon } from "lucide-react";

import { formatElapsedDurationLabel } from "../../timestampFormat";
import { Badge } from "../../components/ui/badge";

export type ArchiveWarningUrgency = "blocking" | "soon" | "fyi" | null;

export interface ArchiveWarningParticipant {
  readonly displayName: string;
  /** Present only for the tooltip on an honest unknown-identity fallback. */
  readonly tooltipParticipantId: string | null;
}

export interface ArchiveWarningRow {
  readonly direction: "inbound" | "outbound";
  readonly participant: ArchiveWarningParticipant;
  readonly urgency: ArchiveWarningUrgency;
  readonly intent: string;
  readonly openedAt: string;
}

export type ArchiveWarningPlacement =
  | { readonly state: "none" }
  | { readonly state: "unknown" }
  | { readonly state: "known"; readonly participants: ReadonlyArray<ArchiveWarningParticipant> };

export interface ArchiveWarningPayload {
  readonly threadTitle: string;
  readonly factsUnavailable: boolean;
  readonly placement: ArchiveWarningPlacement;
  readonly openAsks: ReadonlyArray<ArchiveWarningRow>;
}

const urgencyPresentation = {
  blocking: { label: "Blocking", variant: "destructive" as const },
  soon: { label: "Soon", variant: "warning" as const },
  fyi: { label: "FYI", variant: "secondary" as const },
  none: { label: "No urgency", variant: "secondary" as const },
};

const openAgeLabel = (openedAt: string) =>
  formatElapsedDurationLabel(openedAt) || "couldn't check age";

function ArchiveWarningParticipantName({
  participant,
}: {
  readonly participant: ArchiveWarningParticipant;
}) {
  return (
    <span
      className={
        participant.tooltipParticipantId === null ? "font-medium text-foreground" : "italic"
      }
      title={participant.tooltipParticipantId ?? undefined}
    >
      {participant.displayName}
    </span>
  );
}

function ArchiveWarningRowView({ row }: { readonly row: ArchiveWarningRow }) {
  const urgency = urgencyPresentation[row.urgency ?? "none"];
  const isInbound = row.direction === "inbound";
  const DirectionIcon = isInbound ? InboxIcon : SendIcon;
  return (
    <li className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Badge className="uppercase tracking-wide" size="sm" variant={urgency.variant}>
          {urgency.label}
        </Badge>
        <span className="inline-flex shrink-0 items-center gap-1">
          <DirectionIcon aria-hidden className="size-3" />
          {isInbound ? "From" : "To"}
        </span>
        <ArchiveWarningParticipantName participant={row.participant} />
        <time className="ml-auto shrink-0 tabular-nums" dateTime={row.openedAt}>
          open {openAgeLabel(row.openedAt)}
        </time>
      </div>
      <p
        className="mt-1 line-clamp-3 break-words text-sm leading-snug text-foreground"
        title={row.intent}
      >
        {row.intent}
      </p>
    </li>
  );
}

export function ArchiveWarningContent({ payload }: { readonly payload: ArchiveWarningPayload }) {
  const askCount = payload.openAsks.length;
  const askHeader = `${askCount} open ask${askCount === 1 ? "" : "s"} will be terminated — ${
    askCount === 1 ? "counterparty is" : "counterparties are"
  } notified`;
  return (
    <div className="space-y-3 text-left">
      {payload.factsUnavailable ? <p>Couldn't check open asks or the placement subtree.</p> : null}
      {payload.placement.state === "unknown" && !payload.factsUnavailable ? (
        <p>Placement subtree: couldn't check.</p>
      ) : null}
      {payload.placement.state === "known" ? (
        <p>
          Also archives {payload.placement.participants.length} agent
          {payload.placement.participants.length === 1 ? "" : "s"} placed under{" "}
          {payload.threadTitle}:{" "}
          {payload.placement.participants.map((participant, index) => (
            <span key={`${participant.displayName}-${index}`}>
              {index > 0 ? ", " : null}
              <ArchiveWarningParticipantName participant={participant} />
            </span>
          ))}
          .
        </p>
      ) : null}
      {askCount > 0 ? (
        <section aria-label="Open asks will be terminated and counterparties notified">
          <p className="mb-2 font-medium text-foreground">{askHeader}</p>
          <ol className="space-y-2">
            {payload.openAsks.map((row, index) => (
              <ArchiveWarningRowView key={`${row.direction}-${row.openedAt}-${index}`} row={row} />
            ))}
          </ol>
        </section>
      ) : null}
      <p className="border-t border-border/60 pt-3 text-muted-foreground">
        Worktrees, branches, and pull requests remain. Cleanup is a separate action.
      </p>
    </div>
  );
}

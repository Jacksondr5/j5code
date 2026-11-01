import {
  ARCHIVE_WARNING_WORKSPACE_NOTE,
  archiveWarningAskHeader,
  archiveWarningSeatConsequences,
  sentenceEnd,
  type ArchiveWarningPayload,
  type ArchiveWarningRow,
} from "@t3tools/client-runtime/j5/archive-flow";

import { relativeTime } from "../../lib/time";

// A native alert can't scroll on Android, so long lists and intents are cut with their counts kept.
const MAX_ASK_ROWS = 5;
const MAX_INTENT_LENGTH = 120;

const URGENCY_LABELS = { blocking: "BLOCKING", soon: "SOON", fyi: "FYI", none: "NO URGENCY" };

const clip = (text: string) =>
  text.length <= MAX_INTENT_LENGTH ? text : `${text.slice(0, MAX_INTENT_LENGTH - 1).trimEnd()}…`;

const askRow = (row: ArchiveWarningRow) =>
  `${URGENCY_LABELS[row.urgency ?? "none"]} · ${row.direction === "inbound" ? "From" : "To"} ${
    row.participant.displayName
  } · open ${relativeTime(row.openedAt)}\n“${clip(row.intent)}”`;

/** The web dialog's measured facts, as the plain text a native alert can show. */
export function formatArchiveWarningText(payload: ArchiveWarningPayload): string {
  const sections: string[] = [];
  if (payload.factsUnavailable) {
    sections.push("Couldn't check open asks or the placement subtree.");
  } else {
    if (payload.placement.state === "unknown") sections.push("Placement subtree: couldn't check.");
    if (payload.crews?.state === "unknown") sections.push("Crews it commands: couldn't check.");
  }
  const crews = payload.crews?.state === "known" ? payload.crews.crews : [];
  if (crews.length > 0) {
    const lines = [
      `A Captain is never archived alone. ${crews.length === 1 ? "This Crew retires" : "These Crews retire"} with it, every seat together:`,
    ];
    for (const crew of crews) {
      lines.push(
        `Crew · ${crew.crewName} (${crew.seats.length} ${crew.seats.length === 1 ? "seat" : "seats"})`,
      );
      for (const seat of crew.seats) {
        const consequences = archiveWarningSeatConsequences(seat);
        lines.push(
          `  ${seat.seat} · ${seat.participant.displayName}${consequences === "" ? "" : `: ${consequences}`}`,
        );
      }
    }
    sections.push(lines.join("\n"));
  }
  if (payload.placement.state === "known") {
    const { participants } = payload.placement;
    const names = participants.map((participant) => participant.displayName);
    sections.push(
      `${participants.length} agent${participants.length === 1 ? "" : "s"} placed under ${
        payload.threadTitle
      } keep${participants.length === 1 ? "s" : ""} running: ${names.join(", ")}${sentenceEnd(
        names.at(-1) ?? "",
      )}`,
    );
  }
  const askCount = payload.openAsks.length;
  if (askCount > 0) {
    const rows = payload.openAsks.slice(0, MAX_ASK_ROWS).map(askRow);
    const hidden = askCount - rows.length;
    if (hidden > 0) rows.push(`and ${hidden} more`);
    sections.push([`${archiveWarningAskHeader(askCount)}:`, ...rows].join("\n\n"));
  }
  sections.push(ARCHIVE_WARNING_WORKSPACE_NOTE);
  return sections.join("\n\n");
}

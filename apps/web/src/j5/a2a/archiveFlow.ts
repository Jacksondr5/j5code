import type { ScopedThreadRef } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { readArchivePreflight, type ArchivePreflight } from "./archiveFlowClient";

const pluralize = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const displayParticipant = (participantId: string, labels: ReadonlyMap<string, string>) =>
  labels.get(participantId) ?? participantId;

const displayAge = (openedAt: string) => formatRelativeTimeLabel(openedAt) || "couldn't check age";

export function needsArchiveWarning(preflight: ArchivePreflight): boolean {
  const { facts } = preflight;
  if (facts === null) return true;
  if (facts.state !== "registered") return false;
  return facts.openExchanges.length > 0 || facts.placementSubtree.state !== "none";
}

/** Exact measured facts for the one destructive confirmation; no fact becomes an empty success state. */
export function formatArchiveWarning(input: {
  readonly threadTitle: string;
  readonly preflight: ArchivePreflight;
}): string {
  const { threadTitle, preflight } = input;
  const { facts, participantLabels } = preflight;
  if (facts === null) {
    return [
      `Archive ${threadTitle} anyway?`,
      "",
      "Couldn't check open asks or the placement subtree.",
      "",
      "Worktrees, branches, and pull requests remain. Cleanup is a separate action.",
    ].join("\n");
  }
  if (facts.state !== "registered") return `Archive ${threadTitle} anyway?`;

  const inbound = facts.openExchanges.filter((exchange) => exchange.direction === "inbound");
  const outbound = facts.openExchanges.filter((exchange) => exchange.direction === "outbound");
  const lines = [`Archive ${threadTitle} anyway?`, ""];

  if (facts.placementSubtree.state === "unknown") {
    lines.push("Placement subtree: couldn't check.", "");
  } else if (facts.placementSubtree.state === "known") {
    const names = facts.placementSubtree.participantIds.map((participantId) =>
      displayParticipant(participantId, participantLabels),
    );
    lines.push(
      `Also archives ${pluralize(names.length, "agent")} placed under ${threadTitle}: ${names.join(", ")}.`,
      "",
    );
  }

  if (inbound.length > 0) {
    lines.push(`${pluralize(inbound.length, "participant")} waiting for ${threadTitle}:`);
    lines.push(
      ...inbound.map(
        (exchange) =>
          `${displayParticipant(exchange.counterpartyId, participantLabels)} · ${exchange.urgency ?? "no urgency"} · ${exchange.intent} · open ${displayAge(exchange.openedAt)}`,
      ),
      "",
    );
  }
  if (outbound.length > 0) {
    lines.push(`${pluralize(outbound.length, "open ask")} sent by ${threadTitle}:`);
    lines.push(
      ...outbound.map(
        (exchange) =>
          `${displayParticipant(exchange.counterpartyId, participantLabels)} · ${exchange.urgency ?? "no urgency"} · ${exchange.intent} · open ${displayAge(exchange.openedAt)}`,
      ),
      "",
    );
  }
  lines.push("Worktrees, branches, and pull requests remain. Cleanup is a separate action.");
  return lines.join("\n");
}

/** The action menu owns archive mutation; this J5 delegate owns preflight and the one warning. */
export async function archiveWithPreflight<Result>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly threadTitle: string;
  readonly confirm: (message: string) => Promise<boolean>;
  /** Preserves the existing plain archive preference when no J5 warning is warranted. */
  readonly confirmCleanArchive?: () => Promise<boolean>;
  readonly archive: () => Promise<Result>;
}): Promise<Result | undefined> {
  let preflight: ArchivePreflight;
  try {
    preflight = await readArchivePreflight(input.threadRef);
  } catch {
    preflight = { facts: null, participantLabels: new Map() };
  }
  if (needsArchiveWarning(preflight)) {
    const confirmed = await input.confirm(
      formatArchiveWarning({ threadTitle: input.threadTitle, preflight }),
    );
    if (!confirmed) return undefined;
  } else if (input.confirmCleanArchive && !(await input.confirmCleanArchive())) {
    return undefined;
  }
  return input.archive();
}

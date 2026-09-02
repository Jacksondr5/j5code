import type { ScopedThreadRef } from "@t3tools/contracts";
import { createElement, type ReactNode } from "react";

import { readArchivePreflight, type ArchivePreflight } from "./archiveFlowClient";
import {
  ArchiveWarningContent,
  type ArchiveWarningParticipant,
  type ArchiveWarningPlacement,
  type ArchiveWarningPayload,
  type ArchiveWarningRow,
} from "./ArchiveWarningContent";

export interface ArchiveWarningConfirmation {
  readonly message: string;
  readonly content: ReactNode;
}

const displayParticipant = (
  participantId: string,
  labels: ReadonlyMap<string, string>,
): ArchiveWarningParticipant => {
  const label = labels.get(participantId);
  if (label === undefined) {
    return { displayName: "Unnamed participant", tooltipParticipantId: participantId };
  }
  return {
    displayName: participantId.startsWith("human:") ? `${label} (inbox)` : label,
    tooltipParticipantId: null,
  };
};

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
}): ArchiveWarningConfirmation {
  const { threadTitle, preflight } = input;
  const { facts, participantLabels } = preflight;
  const title = `Archive ${threadTitle}?`;
  if (facts === null) {
    return {
      message: title,
      content: createElement(ArchiveWarningContent, {
        payload: {
          threadTitle,
          factsUnavailable: true,
          placement: { state: "unknown" },
          openAsks: [],
        },
      }),
    };
  }
  if (facts.state !== "registered") {
    return { message: title, content: null };
  }

  const placement: ArchiveWarningPlacement =
    facts.placementSubtree.state === "known"
      ? {
          state: "known",
          participants: facts.placementSubtree.participantIds.map((participantId) =>
            displayParticipant(participantId, participantLabels),
          ),
        }
      : facts.placementSubtree.state === "unknown"
        ? { state: "unknown" }
        : { state: "none" };
  const openAsks: ReadonlyArray<ArchiveWarningRow> = facts.openExchanges.map((exchange) => ({
    direction: exchange.direction,
    participant: displayParticipant(exchange.counterpartyId, participantLabels),
    urgency: exchange.urgency,
    intent: exchange.intent,
    openedAt: exchange.openedAt,
  }));
  const payload: ArchiveWarningPayload = {
    threadTitle,
    factsUnavailable: false,
    placement,
    openAsks,
  };
  return { message: title, content: createElement(ArchiveWarningContent, { payload }) };
}

/** The action menu owns archive mutation; this J5 delegate owns preflight and the one warning. */
export async function archiveWithPreflight<Result>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly threadTitle: string;
  readonly confirm: (confirmation: ArchiveWarningConfirmation) => Promise<boolean>;
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

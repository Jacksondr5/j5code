import {
  crewPreviewIsComplete,
  crewPreviewRuntimeForSeats,
} from "@t3tools/client-runtime/j5/crew-proposals";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalPreviewResponse, CrewProposalSeat } from "@t3tools/contracts/j5";
import { useEffect, useState } from "react";

import { previewCrewProposal } from "./crewProposalsClient";

interface Settled {
  readonly key: string;
  readonly seats: ReadonlyArray<CrewProposalSeat>;
  readonly data: CrewProposalPreviewResponse | null;
  readonly error: string | null;
}

/**
 * The server's runtime preview of exactly these seats. Its approval token counts only while the
 * seats on screen are the ones it previewed, so every removal asks again.
 */
export function useCrewProposalPreview(
  environmentId: EnvironmentId,
  proposalId: string,
  seats: ReadonlyArray<CrewProposalSeat>,
  enabled: boolean,
) {
  const [refreshes, setRefreshes] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);
  const key = JSON.stringify([environmentId, proposalId, seats, refreshes]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to preview the seats on screen, and drops a stale answer.
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const settle = (data: CrewProposalPreviewResponse | null, error: string | null) =>
      current && setSettled({ key, seats, data, error });
    previewCrewProposal(environmentId, { proposalId, seats }).then(
      (data) =>
        crewPreviewIsComplete(data, proposalId, seats)
          ? settle(data, null)
          : settle(null, "The runtime preview is incomplete. Refresh it before approving."),
      (cause: unknown) =>
        settle(null, cause instanceof Error ? cause.message : "Couldn't load the runtime preview."),
    );
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `key` names every input the request reads.
  }, [key, enabled]);
  const active = settled?.key === key ? settled : null;
  return {
    /** Approval authority: only a complete preview of the seats on screen. */
    data: enabled ? (active?.data ?? null) : null,
    /** What each seat runs with, kept from an older preview while its settings are unchanged. */
    runtime:
      settled?.data == null
        ? []
        : crewPreviewRuntimeForSeats(settled.data.seats, settled.seats, seats),
    error: enabled ? (active?.error ?? null) : null,
    loading: enabled && active === null,
    refresh: () => setRefreshes((count) => count + 1),
  };
}

import {
  crewPreviewIsComplete,
  crewPreviewRuntimeForSeats,
} from "@t3tools/client-runtime/j5/crew-proposals";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  CrewProposalPreviewResponse,
  CrewProposalSeat,
  CrewProposalSeatRuntime,
} from "@t3tools/contracts/j5";
import { useEffect, useRef, useState } from "react";

import { previewCrewProposal } from "./crewProposalsClient";

interface Settled {
  readonly key: string;
  readonly data: CrewProposalPreviewResponse | null;
  readonly error: string | null;
}

interface Previewed {
  readonly seat: CrewProposalSeat;
  readonly runtime: CrewProposalSeatRuntime;
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
  // Every seat's latest previewed runtime, so a seat removed and restored keeps its lines.
  const [previewed, setPreviewed] = useState<ReadonlyArray<Previewed>>([]);
  // The preview being asked for: its complete answer, or null when it failed or went stale.
  const inflight = useRef<Promise<CrewProposalPreviewResponse | null>>(Promise.resolve(null));
  const key = JSON.stringify([environmentId, proposalId, seats, refreshes]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to preview the seats on screen, and drops a stale answer.
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const settle = (data: CrewProposalPreviewResponse | null, error: string | null) => {
      if (!current) return null;
      setSettled({ key, data, error });
      if (data === null) return null;
      setPreviewed((rows) => [
        ...rows.filter((row) => !data.seats.some((runtime) => runtime.seat === row.seat.seat)),
        ...data.seats.flatMap((runtime) => {
          const seat = seats.find((candidate) => candidate.seat === runtime.seat);
          return seat === undefined ? [] : [{ seat, runtime }];
        }),
      ]);
      return data;
    };
    inflight.current = previewCrewProposal(environmentId, { proposalId, seats }).then(
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
    /** What each seat runs with, from the latest preview of its unchanged settings. */
    runtime: crewPreviewRuntimeForSeats(
      previewed.map((row) => row.runtime),
      previewed.map((row) => row.seat),
      seats,
    ),
    /** False until the first preview answers, so the seats can wait for their final shape. */
    settled: settled !== null,
    error: enabled ? (active?.error ?? null) : null,
    loading: enabled && active === null,
    /** The answer to the preview in flight, for an Approve tapped before it arrived. */
    next: () => inflight.current,
    refresh: () => setRefreshes((count) => count + 1),
  };
}

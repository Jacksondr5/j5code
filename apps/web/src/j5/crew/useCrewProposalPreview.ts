import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalPreviewResponse, CrewProposalSeat } from "@t3tools/contracts/j5";
import { useCallback, useEffect, useMemo, useState } from "react";

import { previewCrewProposal } from "./crewProposalsClient";

interface PreviewState {
  readonly requestKey: { readonly value: string };
  readonly data: CrewProposalPreviewResponse | null;
  readonly error: string | null;
}

/** A preview authorizes only the roster and environment that were actually shown. */
export function useCrewProposalPreview(
  environmentId: EnvironmentId | null,
  proposalId: string,
  seats: ReadonlyArray<CrewProposalSeat>,
  busy: boolean,
) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<PreviewState | null>(null);
  const requestJson = JSON.stringify([environmentId, proposalId, seats, revision, busy]);
  const requestKey = useMemo(() => ({ value: requestJson }), [requestJson]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (environmentId === null || busy) return;
    let current = true;
    void previewCrewProposal(environmentId, { proposalId, seats }).then(
      (data) => {
        if (!current) return;
        // Refuse incomplete previews instead of approving seats with undisclosed settings.
        const complete =
          data.proposalId === proposalId &&
          data.approvalToken.length > 0 &&
          data.seats.length === seats.length &&
          seats.every((seat) => data.seats.filter((row) => row.seat === seat.seat).length === 1);
        setState({
          requestKey,
          data: complete ? data : null,
          error: complete ? null : "Runtime preview is incomplete. Refresh it before approving.",
        });
      },
      (cause: unknown) => {
        if (!current) return;
        setState({
          requestKey,
          data: null,
          error: cause instanceof Error ? cause.message : "Could not load the runtime preview.",
        });
      },
    );
    return () => {
      current = false;
    };
  }, [environmentId, proposalId, seats, busy, requestKey]);

  const active = state?.requestKey === requestKey ? state : null;
  return {
    data: active?.data ?? null,
    error:
      environmentId === null
        ? "Connect to the crew's environment to preview its runtime."
        : (active?.error ?? null),
    loading:
      environmentId !== null &&
      !busy &&
      (active === null || (active.data === null && active.error === null)),
    refresh,
  };
}

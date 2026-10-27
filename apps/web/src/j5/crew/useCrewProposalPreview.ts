import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalPreviewResponse, CrewProposalSeat } from "@t3tools/contracts/j5";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";

import { previewCrewProposal } from "./crewProposalsClient";

interface PreviewState {
  readonly scopeKey: string;
  readonly proposalKey: string;
  readonly seats: ReadonlyArray<CrewProposalSeat>;
  readonly requestKey: { readonly value: string };
  readonly data: CrewProposalPreviewResponse | null;
  readonly workspaceOptions: CrewProposalPreviewResponse["workspaceOptions"];
  readonly error: string | null;
}

/** A preview authorizes only the roster and environment that were actually shown. */
export function useCrewProposalPreview(
  environmentId: EnvironmentId | null,
  proposalId: string,
  seats: ReadonlyArray<CrewProposalSeat>,
  busy: boolean,
  enabled = true,
  debounceMs = 0,
) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<PreviewState | null>(null);
  const proposalKey = JSON.stringify([environmentId, proposalId]);
  const scopeKey = JSON.stringify([environmentId, proposalId, seats]);
  const requestJson = JSON.stringify([scopeKey, revision, busy, enabled]);
  const requestKey = useMemo(() => ({ value: requestJson }), [requestJson]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  const readRequest = useEffectEvent(() => ({ seats, complete: state?.requestKey === requestKey }));

  useEffect(() => {
    if (environmentId === null || busy || !enabled) return;
    const request = readRequest();
    if (request.complete) return;
    const seats = request.seats;
    let current = true;
    const run = () => {
      void previewCrewProposal(environmentId, { proposalId, seats }).then(
        (data) => {
          if (!current) return;
          // Refuse incomplete previews instead of approving seats with undisclosed settings.
          const complete =
            data.proposalId === proposalId &&
            data.approvalToken.length > 0 &&
            data.seats.length === seats.length &&
            seats.every((seat) => data.seats.filter((row) => row.seat === seat.seat).length === 1);
          setState((previous) => ({
            scopeKey,
            proposalKey,
            seats,
            requestKey,
            data: complete ? data : null,
            workspaceOptions: complete
              ? data.workspaceOptions
              : previous?.proposalKey === proposalKey
                ? previous.workspaceOptions
                : undefined,
            error: complete ? null : "Runtime preview is incomplete. Refresh it before approving.",
          }));
        },
        (cause: unknown) => {
          if (!current) return;
          setState((previous) => ({
            scopeKey,
            proposalKey,
            seats,
            requestKey,
            data: null,
            workspaceOptions:
              previous?.proposalKey === proposalKey ? previous.workspaceOptions : undefined,
            error: cause instanceof Error ? cause.message : "Could not load the runtime preview.",
          }));
        },
      );
    };
    const timer = debounceMs > 0 ? setTimeout(run, debounceMs) : null;
    if (timer === null) run();
    return () => {
      current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [environmentId, proposalId, busy, enabled, requestKey, scopeKey, proposalKey, debounceMs]);

  const active = state?.requestKey === requestKey ? state : null;
  // A previous preview may explain an unchanged runtime, but carries no approval authority.
  const runtimeSeats =
    state?.proposalKey === proposalKey && (!busy || state.scopeKey === scopeKey)
      ? state.data?.seats.filter((runtime) => {
          const current = seats.find((seat) => seat.seat === runtime.seat);
          const previous = state.seats.find((seat) => seat.seat === runtime.seat);
          const settings = (seat: CrewProposalSeat) =>
            JSON.stringify([
              seat.agentId,
              seat.modelSelection,
              seat.runtimeMode,
              seat.workspace,
              seat.steps,
            ]);
          return (
            current !== undefined &&
            previous !== undefined &&
            settings(current) === settings(previous)
          );
        })
      : undefined;
  return {
    data: enabled ? (active?.data ?? null) : null,
    runtimeSeats: runtimeSeats?.length ? runtimeSeats : null,
    workspaceOptions: state?.proposalKey === proposalKey ? state.workspaceOptions : undefined,
    error: !enabled
      ? null
      : environmentId === null
        ? "Connect to the crew's environment to preview its runtime."
        : (active?.error ?? null),
    loading:
      environmentId !== null &&
      enabled &&
      !busy &&
      (active === null || (active.data === null && active.error === null)),
    refresh,
  };
}

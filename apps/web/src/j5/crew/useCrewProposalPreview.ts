import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalPreviewResponse, CrewProposalSeat } from "@t3tools/contracts/j5";
import { useEffect, useEffectEvent, useState } from "react";

import {
  crewPreviewIsComplete,
  crewPreviewRuntimeForSeats,
} from "@t3tools/client-runtime/j5/crew-proposals";

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
) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<PreviewState | null>(null);
  const proposalKey = JSON.stringify([environmentId, proposalId]);
  const scopeKey = JSON.stringify([environmentId, proposalId, seats]);
  const requestJson = JSON.stringify([scopeKey, revision, busy, enabled]);
  // The identity, not the text, marks one request: after an approval attempt the same text asks
  // again, and the earlier answer's approval token must not count for it.
  const requestKey = { value: requestJson };
  const refresh = () => setRevision((value) => value + 1);

  const readRequest = useEffectEvent(() => ({ seats, complete: state?.requestKey === requestKey }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to preview the proposal whenever its seats change, and drops a stale answer.
  useEffect(() => {
    if (environmentId === null || busy || !enabled) return;
    const request = readRequest();
    if (request.complete) return;
    const seats = request.seats;
    let current = true;
    void previewCrewProposal(environmentId, { proposalId, seats }).then(
      (data) => {
        if (!current) return;
        // Refuse incomplete previews instead of approving seats with undisclosed settings.
        const complete = crewPreviewIsComplete(data, proposalId, seats);
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
    return () => {
      current = false;
    };
  }, [environmentId, proposalId, busy, enabled, requestKey, scopeKey, proposalKey]);

  const active = state?.requestKey === requestKey ? state : null;
  // A previous preview may explain an unchanged runtime, but carries no approval authority.
  const runtimeSeats =
    state?.proposalKey === proposalKey && (!busy || state.scopeKey === scopeKey)
      ? crewPreviewRuntimeForSeats(state.data?.seats ?? [], state.seats, seats)
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

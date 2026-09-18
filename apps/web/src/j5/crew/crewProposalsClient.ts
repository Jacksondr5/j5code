import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  CrewProposal,
  CrewProposalResolveRequest,
  ScopedCrewProposal,
} from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  crewProposalSourcesAtom,
  crewProposalsQueryAtom,
  j5Environment,
  refreshJ5Sources,
} from "../state";
import { createVisibleRefreshHook } from "../useVisibleRefresh";

export type { CrewProposal, CrewProposalSeat, ScopedCrewProposal } from "@t3tools/contracts/j5";

export const CREW_PROPOSALS_POLL_INTERVAL_MS = 7_500;

/** Every environment's open gates, each tagged with the environment it must be answered on. */
export const mergeCrewProposalSources = (
  sources: J5ReadSources<ReadonlyArray<CrewProposal>>,
): ReadonlyArray<ScopedCrewProposal> =>
  sources.sources.flatMap((source) =>
    (source.data ?? []).map((proposal) => ({ ...proposal, environmentId: source.environmentId })),
  );

/** Approve (with the final seats) or decline one proposal on the environment that holds it. */
export async function resolveCrewProposal(
  environmentId: EnvironmentId,
  input: CrewProposalResolveRequest,
) {
  const result = await j5Environment.resolveCrewProposal.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** Forced re-read after a decision, so the gate leaves the screen without waiting for the poll. */
export const refreshCrewProposals = (environmentId?: EnvironmentId) =>
  refreshJ5Sources(crewProposalSourcesAtom, crewProposalsQueryAtom, {
    force: true,
    ...(environmentId === undefined ? {} : { environmentId }),
  });

/** The bell, the inbox page, and every composer's inline gate share this one foreground poll. */
export const useCrewProposalsRefresh = createVisibleRefreshHook(() => {
  void refreshJ5Sources(crewProposalSourcesAtom, crewProposalsQueryAtom);
}, CREW_PROPOSALS_POLL_INTERVAL_MS);

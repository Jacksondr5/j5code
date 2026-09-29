import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewRuntimeRequestRespondRequest } from "@t3tools/contracts/j5";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { useMemo } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  crewApprovalPollAtom,
  crewRuntimeRequestSourcesAtom,
  crewRuntimeRequestsQueryAtom,
  j5Environment,
  refreshJ5Sources,
} from "../state";
import { createVisibleRefreshHook } from "../useVisibleRefresh";
import { mergeCrewRuntimeRequestSources } from "./crewRuntimeRequests.logic";

export const CREW_RUNTIME_REQUESTS_POLL_INTERVAL_MS = 7_500;

/** Answer on the environment that holds the thread; the refusal message says why it failed. */
export async function respondCrewRuntimeRequest(
  environmentId: EnvironmentId,
  input: CrewRuntimeRequestRespondRequest,
) {
  const result = await j5Environment.respondCrewRuntimeRequest.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** Forced re-read after an answer, so the item leaves the Inbox without waiting for a poll. */
export const refreshCrewRuntimeRequests = (environmentId?: EnvironmentId) =>
  refreshJ5Sources(crewRuntimeRequestSourcesAtom, crewRuntimeRequestsQueryAtom, {
    force: true,
    ...(environmentId === undefined ? {} : { environmentId }),
  });

/**
 * Re-reads only the environments with a thread waiting on an approval; sends nothing while none is.
 * An environment entering the plan needs no call here: its query mounts and fetches on its own.
 */
const refreshPolledEnvironments = () => {
  for (const environmentId of appAtomRegistry.get(crewApprovalPollAtom).environmentIds)
    void refreshJ5Sources(crewRuntimeRequestSourcesAtom, crewRuntimeRequestsQueryAtom, {
      environmentId,
    });
};

/** The bell and the Inbox page share this poll. */
export const useCrewRuntimeRequestsRefresh = createVisibleRefreshHook(
  refreshPolledEnvironments,
  CREW_RUNTIME_REQUESTS_POLL_INTERVAL_MS,
);

export function useCrewRuntimeRequests() {
  const sources = useAtomValue(crewRuntimeRequestSourcesAtom);
  useCrewRuntimeRequestsRefresh();
  return useMemo(() => mergeCrewRuntimeRequestSources(sources), [sources]);
}

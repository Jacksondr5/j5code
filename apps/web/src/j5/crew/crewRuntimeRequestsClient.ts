import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewRuntimeRequestRespondRequest } from "@t3tools/contracts/j5";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { useEffect, useMemo } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  crewApprovalPollAtom,
  crewRuntimeRequestSourcesAtom,
  crewRuntimeRequestsQueryAtom,
  j5Environment,
  refreshJ5Sources,
} from "../state";
import { startVisibleRefresh } from "../useVisibleRefresh";
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

/** Re-reads only the environments with a thread waiting on an approval. */
const refreshPolledEnvironments = () => {
  for (const environmentId of appAtomRegistry.get(crewApprovalPollAtom).environmentIds)
    void refreshJ5Sources(crewRuntimeRequestSourcesAtom, crewRuntimeRequestsQueryAtom, {
      environmentId,
    });
};

// One foreground poll shared by every consumer, running only while some approval is pending.
let consumers = 0;
let polledKey: string | null = null;
let stopPoll: (() => void) | undefined;

const syncPoll = (key: string) => {
  if (polledKey === key) return;
  polledKey = key;
  stopPoll?.();
  stopPoll = undefined;
  if (key === "") return;
  // A thread raised or cleared its flag: re-read now, then keep polling while any stays raised.
  refreshPolledEnvironments();
  stopPoll = startVisibleRefresh(refreshPolledEnvironments, CREW_RUNTIME_REQUESTS_POLL_INTERVAL_MS);
};

/** The bell and the Inbox page share this poll; nothing is read while no approval is pending. */
export function useCrewRuntimeRequestsRefresh() {
  const { key } = useAtomValue(crewApprovalPollAtom);
  useEffect(() => {
    consumers += 1;
    return () => {
      consumers -= 1;
      if (consumers > 0) return;
      stopPoll?.();
      stopPoll = undefined;
      polledKey = null;
    };
  }, []);
  useEffect(() => syncPoll(key), [key]);
}

export function useCrewRuntimeRequests() {
  const sources = useAtomValue(crewRuntimeRequestSourcesAtom);
  useCrewRuntimeRequestsRefresh();
  return useMemo(() => mergeCrewRuntimeRequestSources(sources), [sources]);
}

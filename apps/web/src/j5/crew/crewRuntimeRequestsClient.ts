import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewRuntimeRequestRespondRequest } from "@t3tools/contracts/j5";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { useMemo } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  crewRuntimeRequestSourcesAtom,
  crewRuntimeRequestsQueryAtom,
  j5Environment,
  refreshJ5Sources,
} from "../state";
import { createVisibleRefreshHook } from "../useVisibleRefresh";
import {
  inboxRequestIdsForThread,
  mergeCrewRuntimeRequestSources,
  withoutInboxRequests,
} from "./crewRuntimeRequests.logic";

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

/** Forced re-read after an answer, so the item leaves the Inbox and the thread without a poll. */
export const refreshCrewRuntimeRequests = (environmentId?: EnvironmentId) =>
  refreshJ5Sources(crewRuntimeRequestSourcesAtom, crewRuntimeRequestsQueryAtom, {
    force: true,
    ...(environmentId === undefined ? {} : { environmentId }),
  });

/** The bell, the Inbox page, and every open thread share this one foreground poll. */
export const useCrewRuntimeRequestsRefresh = createVisibleRefreshHook(() => {
  void refreshJ5Sources(crewRuntimeRequestSourcesAtom, crewRuntimeRequestsQueryAtom);
}, CREW_RUNTIME_REQUESTS_POLL_INTERVAL_MS);

export function useCrewRuntimeRequests() {
  const sources = useAtomValue(crewRuntimeRequestSourcesAtom);
  useCrewRuntimeRequestsRefresh();
  return useMemo(() => mergeCrewRuntimeRequestSources(sources), [sources]);
}

/**
 * ChatView's one J5 hook (FORK.md): a Captain's or seat's provider approvals and questions are
 * answered from the Inbox, so the composer gets only the pending requests the Inbox does not hold.
 * Every other thread's requests pass through unchanged. `routed` is how many moved, for the note.
 */
export function useJ5CrewRoutedRequests<
  T extends {
    readonly approvals: ReadonlyArray<{ readonly requestId: string }>;
    readonly userInputs: ReadonlyArray<{ readonly requestId: string }>;
  },
>(environmentId: EnvironmentId | undefined, threadId: string | null | undefined, pending: T): T {
  const requests = useCrewRuntimeRequests();
  const inboxIds = useMemo(
    () => inboxRequestIdsForThread(requests, environmentId, threadId),
    [requests, environmentId, threadId],
  );
  return useMemo(() => withoutInboxRequests(pending, inboxIds), [pending, inboxIds]);
}

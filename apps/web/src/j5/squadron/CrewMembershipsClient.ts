import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { listCrewMemberships } from "@t3tools/client-runtime/j5/http";
import { createScopedThreadReadStore } from "@t3tools/client-runtime/j5/threadHomes";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { CrewMembershipEntry, ThreadCrewMembership } from "@t3tools/contracts/j5";
import { useSyncExternalStore } from "react";

import { runtime } from "../../lib/runtime";

export type { CrewMembershipEntry, ThreadCrewMembership } from "@t3tools/contracts/j5";

/** Sidebar chip copy: a member names its seat, a Captain names how many live Crews it runs. */
export function presentCrewMembership(
  membership: ThreadCrewMembership | undefined,
): { readonly label: string; readonly title: string } | null {
  if (membership === undefined) return null;
  if (membership.kind === "member") {
    if (membership.crew.archived) return null;
    return {
      label: `${membership.crew.crewName} · ${membership.seat}`,
      title: `Seat ${membership.seat} of crew ${membership.crew.crewName}`,
    };
  }
  const live = membership.crews.filter((crew) => !crew.archived);
  if (live.length === 0) return null;
  return {
    label: "Captain",
    title: `Commands ${live.map((crew) => crew.crewName).join(", ")}`,
  };
}

/** The visible rows are the whole truth: a thread that left every Crew loses its chip on the next read. */
export const replaceCrewMemberships = (
  previous: ReadonlyMap<string, ThreadCrewMembership>,
  environmentId: EnvironmentId,
  requested: ReadonlyArray<ThreadId>,
  entries: ReadonlyArray<CrewMembershipEntry>,
) => {
  const next = new Map(previous);
  for (const threadId of requested)
    next.delete(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  for (const entry of entries)
    next.set(scopedThreadKey(scopeThreadRef(environmentId, entry.threadId)), entry.membership);
  return next;
};

const store = createScopedThreadReadStore<ThreadCrewMembership, CrewMembershipEntry>({
  load: (prepared, threadIds) => runtime.runPromise(listCrewMemberships(prepared, threadIds)),
  replace: replaceCrewMemberships,
});

/**
 * Called beside the thread-home read whenever the row set changes; incremental, so a shells or
 * connection change reads only the rows not yet answered for (an empty answer counts). A thread
 * can gain or lose a Crew at any time: a launch or decision on this device re-reads every
 * requested row, and the Fleet poll re-reads only the rows the roster names as involved.
 */
export const requestCrewMemberships = (
  refs: ReadonlyArray<ScopedThreadRef>,
  connections: ReadonlyMap<EnvironmentId, PreparedConnection | null>,
  force = false,
) => {
  store.setConnections(connections);
  store.request(refs, force);
};

export const refreshCrewMemberships = () => store.refreshRequested();
/** The Fleet poll's re-read: only the rows the roster says sit in or command a Crew. */
export const refreshCrewMembershipRows = (refs: ReadonlyArray<ScopedThreadRef>) =>
  store.refreshRows(refs);

export function useCrewMembership(
  ref: ScopedThreadRef | undefined,
): ThreadCrewMembership | undefined {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return ref === undefined ? undefined : snapshot.get(scopedThreadKey(ref));
}

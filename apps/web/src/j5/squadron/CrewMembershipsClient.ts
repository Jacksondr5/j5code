import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { listCrewMemberships } from "@t3tools/client-runtime/j5/http";
import { createScopedThreadReadStore } from "@t3tools/client-runtime/j5/threadHomes";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { CrewMembershipEntry, ThreadCrewMembership } from "@t3tools/contracts/j5";
import { useSyncExternalStore } from "react";

import { runtime } from "../../lib/runtime";

export type { CrewMembershipEntry, ThreadCrewMembership } from "@t3tools/contracts/j5";

/**
 * Sidebar identity for a Crew relation: a member's chip names its Crew and seat; a Captain gets
 * the anchor mark, with the live Crews it commands in the tooltip.
 */
export function presentCrewMembership(
  membership: ThreadCrewMembership | undefined,
):
  | { readonly kind: "seat"; readonly label: string; readonly title: string }
  | { readonly kind: "captain"; readonly title: string }
  | null {
  if (membership === undefined) return null;
  if (membership.kind === "member") {
    if (membership.crew.archived) return null;
    return {
      kind: "seat",
      label: `${membership.crew.crewName} · ${membership.seat}`,
      title: `Seat ${membership.seat} of crew ${membership.crew.crewName}`,
    };
  }
  const live = membership.crews.filter((crew) => !crew.archived);
  if (live.length === 0) return null;
  return { kind: "captain", title: `Commands ${live.map((crew) => crew.crewName).join(", ")}` };
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
/**
 * The Fleet poll's re-read: the rows the roster says sit in or command a Crew, plus every row
 * still showing a chip, so a Captain whose last Crew retired (here or on another device) is
 * re-read once more and its chip clears rather than staying until reload.
 */
export const refreshCrewMembershipRows = (refs: ReadonlyArray<ScopedThreadRef>) =>
  store.refreshRows(refs, { held: true });

export function useCrewMembership(
  ref: ScopedThreadRef | undefined,
): ThreadCrewMembership | undefined {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return ref === undefined ? undefined : snapshot.get(scopedThreadKey(ref));
}

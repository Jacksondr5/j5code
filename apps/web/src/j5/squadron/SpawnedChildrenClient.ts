import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { listSpawnedChildren } from "@t3tools/client-runtime/j5/http";
import { createScopedThreadReadStore } from "@t3tools/client-runtime/j5/threadHomes";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { SpawnedChild, SpawnedChildrenEntry } from "@t3tools/contracts/j5";
import { useSyncExternalStore } from "react";

import { runtime } from "../../lib/runtime";

export type { SpawnedChild, SpawnedChildrenEntry } from "@t3tools/contracts/j5";

/** The visible rows are the whole truth for their children; parents that lost all children lose their entry. */
export const replaceSpawnedChildren = (
  previous: ReadonlyMap<string, ReadonlyArray<SpawnedChild>>,
  environmentId: EnvironmentId,
  requested: ReadonlyArray<ThreadId>,
  entries: ReadonlyArray<SpawnedChildrenEntry>,
) => {
  const next = new Map(previous);
  for (const threadId of requested)
    next.delete(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  for (const entry of entries)
    next.set(scopedThreadKey(scopeThreadRef(environmentId, entry.threadId)), entry.children);
  return next;
};

const store = createScopedThreadReadStore<ReadonlyArray<SpawnedChild>, SpawnedChildrenEntry>({
  load: (prepared, threadIds) => runtime.runPromise(listSpawnedChildren(prepared, threadIds)),
  replace: replaceSpawnedChildren,
});

/**
 * Incremental beside the thread-home read; `refreshSpawnedChildren` re-reads every requested row
 * after a launch or decision on this device, the Fleet poll only the involved ones.
 */
export const requestSpawnedChildren = (
  refs: ReadonlyArray<ScopedThreadRef>,
  connections: ReadonlyMap<EnvironmentId, PreparedConnection | null>,
  force = false,
) => {
  store.setConnections(connections);
  store.request(refs, force);
};

export const refreshSpawnedChildren = () => store.refreshRequested();
/**
 * The Fleet poll's re-read: the rows the roster says have placed children or sit in a Crew, plus
 * every row still showing children, so a parent whose children all archived loses them.
 */
export const refreshSpawnedChildrenRows = (refs: ReadonlyArray<ScopedThreadRef>) =>
  store.refreshRows(refs, { held: true });

const EMPTY: ReadonlyArray<SpawnedChild> = [];

export function useSpawnedChildren(ref: ScopedThreadRef): ReadonlyArray<SpawnedChild> {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return snapshot.get(scopedThreadKey(ref)) ?? EMPTY;
}

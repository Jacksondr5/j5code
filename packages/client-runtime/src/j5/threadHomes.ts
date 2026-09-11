import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { ThreadHome, ThreadHomeEntry } from "@t3tools/contracts/j5";

import type { PreparedConnection } from "../connection/model.ts";
import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

export type ThreadHomesScopeReadState = "ready" | "failed";

export const replaceThreadHomeEntries = (
  homes: ReadonlyMap<string, ThreadHome>,
  environmentId: EnvironmentId,
  entries: ReadonlyArray<ThreadHomeEntry>,
) => {
  const next = new Map(homes);
  for (const entry of entries)
    next.set(scopedThreadKey(scopeThreadRef(environmentId, entry.threadId)), entry.home);
  return next;
};

interface EnvironmentHomes {
  prepared: PreparedConnection | null;
  readonly requested: Set<ThreadId>;
  readonly pending: Set<ThreadId>;
  reading: { readonly threadIds: ReadonlySet<ThreadId> } | null;
  scopeReadState: ThreadHomesScopeReadState;
}

/** Batches only missing/invalidated homes per environment and discards reads from replaced connections. */
export function createThreadHomesStore(
  load: (
    prepared: PreparedConnection,
    threadIds: ReadonlyArray<ThreadId>,
  ) => Promise<ReadonlyArray<ThreadHomeEntry>>,
) {
  let homes: ReadonlyMap<string, ThreadHome> = new Map();
  const environments = new Map<EnvironmentId, EnvironmentHomes>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const readPending = (environmentId: EnvironmentId, state: EnvironmentHomes) => {
    if (state.reading !== null || state.prepared === null || state.pending.size === 0) return;
    const threadIds = [...state.pending];
    const reading = { threadIds: new Set(threadIds) };
    state.reading = reading;
    state.pending.clear();
    void load(state.prepared, threadIds)
      .then((entries) => {
        if (environments.get(environmentId) !== state || state.reading !== reading) return;
        homes = replaceThreadHomeEntries(homes, environmentId, entries);
        state.scopeReadState = "ready";
      })
      .catch(() => {
        if (environments.get(environmentId) !== state || state.reading !== reading) return;
        state.scopeReadState = "failed";
      })
      .finally(() => {
        if (environments.get(environmentId) !== state || state.reading !== reading) return;
        state.reading = null;
        notify();
        readPending(environmentId, state);
      });
  };

  const setConnections = (connections: ReadonlyMap<EnvironmentId, PreparedConnection | null>) => {
    let changed = false;
    for (const [environmentId, state] of environments) {
      if (connections.has(environmentId)) continue;
      environments.delete(environmentId);
      const next = new Map(homes);
      for (const threadId of state.requested)
        next.delete(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
      homes = next;
      changed = true;
    }
    for (const [environmentId, prepared] of connections) {
      const state = environments.get(environmentId);
      if (state === undefined) {
        environments.set(environmentId, {
          prepared,
          requested: new Set(),
          pending: new Set(),
          reading: null,
          scopeReadState: prepared === null ? "failed" : "ready",
        });
        changed = true;
      } else if (state.prepared !== prepared) {
        state.prepared = prepared;
        state.reading = null;
        state.scopeReadState = prepared === null ? "failed" : "ready";
        for (const threadId of state.requested) state.pending.add(threadId);
        changed = true;
        readPending(environmentId, state);
      }
    }
    if (changed) notify();
  };

  const request = (refs: ReadonlyArray<ScopedThreadRef>, force = false) => {
    const touched = new Set<EnvironmentId>();
    for (const ref of refs) {
      const state = environments.get(ref.environmentId);
      if (state === undefined) continue;
      state.requested.add(ref.threadId);
      if (
        force ||
        (!homes.has(scopedThreadKey(ref)) && !state.reading?.threadIds.has(ref.threadId))
      )
        state.pending.add(ref.threadId);
      touched.add(ref.environmentId);
    }
    for (const environmentId of touched)
      readPending(environmentId, environments.get(environmentId)!);
  };

  return {
    setConnections,
    request,
    getSnapshot: () => homes,
    getScopeReadState: (environmentId: EnvironmentId | null): ThreadHomesScopeReadState =>
      environmentId === null
        ? "ready"
        : (environments.get(environmentId)?.scopeReadState ?? "failed"),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

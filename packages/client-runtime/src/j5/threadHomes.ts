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

interface EnvironmentReads {
  prepared: PreparedConnection | null;
  readonly requested: Set<ThreadId>;
  readonly pending: Set<ThreadId>;
  /** Rows a completed batch has answered for, including the ones it did not mention (a negative). */
  readonly loaded: Set<ThreadId>;
  reading: { readonly threadIds: ReadonlySet<ThreadId> } | null;
  scopeReadState: ThreadHomesScopeReadState;
}

/**
 * A per-thread read model keyed by scoped thread ref, filled by batched reads per environment.
 * Thread homes, Crew memberships, and spawned children all fit this shape: the sidebar asks for
 * the visible rows, each environment reads only what it is missing (or everything when forced),
 * and a read from a replaced connection or a removed environment is discarded. `replace` decides
 * how a batch of entries updates the map for the threads that were requested, so a read model
 * where absence is meaningful (a thread that left its Crew) can delete keys the batch did not
 * mention. A row a batch answered for is loaded whether or not it got a value, so a negative is
 * never re-read just because the requested set changed shape; only `refreshRows` and
 * `refreshRequested` re-read rows on purpose. A batch that changes nothing keeps the previous
 * map, so subscribers see the same snapshot and skip their render.
 */
/** Every J5 per-thread read route caps a body at 500 ids; batches stay well under it. */
export const THREAD_READ_BATCH_SIZE = 200;

export function createScopedThreadReadStore<Value, Entry>(options: {
  readonly load: (
    prepared: PreparedConnection,
    threadIds: ReadonlyArray<ThreadId>,
  ) => Promise<ReadonlyArray<Entry>>;
  readonly replace: (
    current: ReadonlyMap<string, Value>,
    environmentId: EnvironmentId,
    requested: ReadonlyArray<ThreadId>,
    entries: ReadonlyArray<Entry>,
  ) => ReadonlyMap<string, Value>;
  /** Value equality for the unchanged-batch check; structural by default, values are plain JSON. */
  readonly equal?: (left: Value, right: Value) => boolean;
}) {
  const equal = options.equal ?? ((left, right) => JSON.stringify(left) === JSON.stringify(right));
  const sameEntries = (left: ReadonlyMap<string, Value>, right: ReadonlyMap<string, Value>) => {
    if (left.size !== right.size) return false;
    for (const [key, value] of right) {
      const previous = left.get(key);
      if (previous === undefined || !equal(previous, value)) return false;
    }
    return true;
  };
  let values: ReadonlyMap<string, Value> = new Map();
  const environments = new Map<EnvironmentId, EnvironmentReads>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const readPending = (environmentId: EnvironmentId, state: EnvironmentReads) => {
    if (state.reading !== null || state.prepared === null || state.pending.size === 0) return;
    // One batch at a time; the rest stay pending and follow in `finally`.
    const threadIds = [...state.pending].slice(0, THREAD_READ_BATCH_SIZE);
    const reading = { threadIds: new Set(threadIds) };
    state.reading = reading;
    for (const threadId of threadIds) state.pending.delete(threadId);
    void options
      .load(state.prepared, threadIds)
      .then((entries) => {
        if (environments.get(environmentId) !== state || state.reading !== reading) return;
        const next = options.replace(values, environmentId, threadIds, entries);
        if (!sameEntries(values, next)) values = next;
        for (const threadId of threadIds) state.loaded.add(threadId);
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
      const next = new Map(values);
      for (const threadId of state.requested)
        next.delete(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
      values = next;
      changed = true;
    }
    for (const [environmentId, prepared] of connections) {
      const state = environments.get(environmentId);
      if (state === undefined) {
        environments.set(environmentId, {
          prepared,
          requested: new Set(),
          pending: new Set(),
          loaded: new Set(),
          reading: null,
          scopeReadState: prepared === null ? "failed" : "ready",
        });
        changed = true;
      } else if (state.prepared !== prepared) {
        state.prepared = prepared;
        state.reading = null;
        state.loaded.clear();
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
      if (force || (!state.loaded.has(ref.threadId) && !state.reading?.threadIds.has(ref.threadId)))
        state.pending.add(ref.threadId);
      touched.add(ref.environmentId);
    }
    for (const environmentId of touched)
      readPending(environmentId, environments.get(environmentId)!);
  };

  /** Re-read every row any caller asked for, per environment; absence in the reply is authoritative. */
  const refreshRequested = () => {
    for (const [environmentId, state] of environments) {
      for (const threadId of state.requested) state.pending.add(threadId);
      readPending(environmentId, state);
    }
  };

  /**
   * Re-read only these rows, and only where a caller asked for them: the periodic poll names the
   * rows some other read says are involved, so its cost follows that involvement rather than the
   * length of the thread list.
   */
  const refreshRows = (refs: ReadonlyArray<ScopedThreadRef>) => {
    const touched = new Set<EnvironmentId>();
    for (const ref of refs) {
      const state = environments.get(ref.environmentId);
      if (state === undefined || !state.requested.has(ref.threadId)) continue;
      state.pending.add(ref.threadId);
      touched.add(ref.environmentId);
    }
    for (const environmentId of touched)
      readPending(environmentId, environments.get(environmentId)!);
  };

  return {
    setConnections,
    request,
    refreshRequested,
    refreshRows,
    getSnapshot: () => values,
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

/**
 * Homes never go away, so a batch only adds and updates; a thread the batch did not mention
 * keeps whatever home it had.
 */
export function createThreadHomesStore(
  load: (
    prepared: PreparedConnection,
    threadIds: ReadonlyArray<ThreadId>,
  ) => Promise<ReadonlyArray<ThreadHomeEntry>>,
) {
  return createScopedThreadReadStore<ThreadHome, ThreadHomeEntry>({
    load,
    replace: (current, environmentId, _requested, entries) =>
      replaceThreadHomeEntries(current, environmentId, entries),
  });
}

import { useEffect, useSyncExternalStore } from "react";

import { listSquadrons, type ManagedSquadron } from "./squadronClient";

export type SquadronDirectoryState =
  | { readonly status: "loading"; readonly squadrons: ReadonlyArray<ManagedSquadron> }
  | { readonly status: "ready"; readonly squadrons: ReadonlyArray<ManagedSquadron> }
  | { readonly status: "error"; readonly squadrons: ReadonlyArray<ManagedSquadron> };

let snapshot: SquadronDirectoryState = { status: "loading", squadrons: [] };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let queuedForceRefresh: Promise<void> | null = null;
let hasLoaded = false;

const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => snapshot;

export const refreshSquadronDirectory = (options: { readonly force?: boolean } = {}) => {
  if (options.force === true && queuedForceRefresh !== null) return queuedForceRefresh;
  if (loading !== null) {
    if (options.force !== true) return loading;
    const queuedRefresh: Promise<void> = loading.then(() => {
      // Clear before starting the queued read so it cannot return itself when
      // it re-enters this single-flight function.
      if (queuedForceRefresh === queuedRefresh) {
        queuedForceRefresh = null;
      }
      return refreshSquadronDirectory({ force: true });
    });
    queuedForceRefresh = queuedRefresh;
    return queuedForceRefresh;
  }
  if (hasLoaded && options.force !== true) return Promise.resolve();
  snapshot = { status: "loading", squadrons: snapshot.squadrons };
  notify();
  loading = listSquadrons()
    .then((squadrons) => {
      snapshot = { status: "ready", squadrons };
      hasLoaded = true;
    })
    .catch(() => {
      // Keep the selected scope resolvable on a transient failure; clearing
      // this list would silently turn a selected Squadron into zoom-out.
      snapshot = { status: "error", squadrons: snapshot.squadrons };
      hasLoaded = false;
    })
    .finally(() => {
      loading = null;
      notify();
    });
  return loading;
};

/** One authenticated directory read is shared by the gate and visible scope controls. */
export function useSquadronDirectory() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void refreshSquadronDirectory();
  }, []);
  return { ...state, refresh: refreshSquadronDirectory };
}

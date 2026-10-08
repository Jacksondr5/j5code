import type { ScopedSquadronRef } from "@t3tools/contracts/j5";
import { useSyncExternalStore } from "react";

import { resolveScopeAfterSquadronDelete } from "./SquadronActions.logic";

type Snapshot = {
  readonly ambientSquadronRef: ScopedSquadronRef | null;
  readonly ambientScopeSelectionGeneration: number;
};

let snapshot: Snapshot = {
  ambientSquadronRef: null,
  ambientScopeSelectionGeneration: 0,
};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const setAmbientSquadronScope = (scope: ScopedSquadronRef | null) => {
  snapshot = {
    ambientSquadronRef: scope,
    ambientScopeSelectionGeneration: snapshot.ambientScopeSelectionGeneration + 1,
  };
  notify();
};

/** A deleted Squadron leaves the ambient scope. */
export const forgetDeletedSquadron = (deleted: ScopedSquadronRef) => {
  const ambientSquadronRef = resolveScopeAfterSquadronDelete(snapshot.ambientSquadronRef, deleted);
  if (ambientSquadronRef === snapshot.ambientSquadronRef) return;
  snapshot = { ...snapshot, ambientSquadronRef };
  notify();
};

export function useSquadronAmbientScope() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.ambientSquadronRef,
    () => null,
  );
}

/** Changes on every scope selection, including an explicit reselect of the current scope. */
export function useSquadronAmbientScopeSelectionGeneration() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.ambientScopeSelectionGeneration,
    () => 0,
  );
}

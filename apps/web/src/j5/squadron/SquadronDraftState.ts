import { useSyncExternalStore } from "react";

import {
  freezeSquadronForFirstSend,
  selectSquadronForDraft,
  type SquadronDraftState,
} from "./SquadronScope.logic";

type Snapshot = {
  readonly ambientSquadronId: string | null;
  readonly draftStates: Readonly<Record<string, SquadronDraftState<null>>>;
};

let snapshot: Snapshot = { ambientSquadronId: null, draftStates: {} };
const listeners = new Set<() => void>();
const emptyDraftStates = new Map<string, SquadronDraftState<null>>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => snapshot;

const draftStateFor = (draftKey: string) => {
  const current = snapshot.draftStates[draftKey];
  if (current !== undefined) return current;
  const cached = emptyDraftStates.get(draftKey);
  if (cached !== undefined) return cached;
  const empty: SquadronDraftState<null> = {
    squadronId: null,
    frozenAtFirstSend: false,
    content: null,
  };
  emptyDraftStates.set(draftKey, empty);
  return empty;
};

export const setAmbientSquadronId = (squadronId: string | null) => {
  snapshot = { ...snapshot, ambientSquadronId: squadronId };
  notify();
};

export const selectDraftSquadron = (draftKey: string, squadronId: string) => {
  const current = draftStateFor(draftKey);
  const next = selectSquadronForDraft(current, squadronId);
  if (next === current) return;
  snapshot = { ...snapshot, draftStates: { ...snapshot.draftStates, [draftKey]: next } };
  notify();
};

export const freezeDraftSquadronAtFirstSend = (draftKey: string) => {
  const current = draftStateFor(draftKey);
  const next = freezeSquadronForFirstSend(current);
  snapshot = { ...snapshot, draftStates: { ...snapshot.draftStates, [draftKey]: next } };
  notify();
  return next.squadronId;
};

export function useSquadronAmbientScope() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.ambientSquadronId,
    () => null,
  );
}

export function useSquadronDraftScope(draftKey: string) {
  return useSyncExternalStore(
    subscribe,
    () => draftStateFor(draftKey),
    () => draftStateFor(draftKey),
  );
}

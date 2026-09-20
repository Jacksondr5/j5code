import { useSyncExternalStore } from "react";

/** Which saved agent a new-task draft launches as, keyed by the composer draft key. Session-local. */
let snapshot: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const selectDraftAgent = (draftKey: string, personaId: string | null) => {
  if ((snapshot[draftKey] ?? null) === personaId) return;
  const next = { ...snapshot };
  if (personaId === null) delete next[draftKey];
  else next[draftKey] = personaId;
  snapshot = next;
  notify();
};

export const clearDraftAgent = (draftKey: string) => selectDraftAgent(draftKey, null);

export const readDraftAgentPersonaId = (draftKey: string): string | null =>
  snapshot[draftKey] ?? null;

export function useDraftAgentPersonaId(draftKey: string | null): string | null {
  return useSyncExternalStore(subscribe, () =>
    draftKey === null ? null : (snapshot[draftKey] ?? null),
  );
}

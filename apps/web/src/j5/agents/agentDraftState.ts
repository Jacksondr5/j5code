import { useSyncExternalStore } from "react";

/**
 * Which saved agent a new-task draft should launch as, keyed by the route's thread key.
 * Session-local like the squadron draft carrier: the server resolves and pins the real
 * assignment at first send, so nothing here needs to persist.
 */
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

/** First-send launch carrier: spread into `createThread`; empty when no agent is chosen. */
export const draftAgentPersonaLaunch = (draftKey: string) => {
  const personaId = readDraftAgentPersonaId(draftKey);
  return personaId === null ? {} : { agentPersona: { personaId } };
};

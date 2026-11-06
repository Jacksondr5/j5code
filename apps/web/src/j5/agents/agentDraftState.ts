import { useSyncExternalStore } from "react";

import {
  type ComposerThreadTarget,
  resolveComposerDraftKey,
  useComposerDraftStore,
} from "../../composerDraftStore";

/**
 * Which persona a new-task draft should launch as, keyed by the route's thread key.
 * Session-local: the server resolves and pins the real
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

const readDraftAgentPersonaId = (draftKey: string): string | null => snapshot[draftKey] ?? null;

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

/**
 * After a successful first send. A persona launches on the route the server resolves, so the
 * draft's model picks never ran: they are dropped, or the started thread's composer would show
 * them and an effort change would switch the worker onto a model nobody picked.
 */
export const finishDraftAgentSend = (draftKey: string, draftTarget: ComposerThreadTarget) => {
  if (readDraftAgentPersonaId(draftKey) !== null) {
    useComposerDraftStore.setState((state) => {
      const key = resolveComposerDraftKey(state, draftTarget);
      const draft = key === null ? undefined : state.draftsByThreadKey[key];
      if (key === null || draft === undefined) return state;
      const { modelSelectionExplicit: _explicit, ...rest } = draft;
      return {
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [key]: { ...rest, activeProvider: null, modelSelectionByProvider: {} },
        },
      };
    });
  }
  clearDraftAgent(draftKey);
};

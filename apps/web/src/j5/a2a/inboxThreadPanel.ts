import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { KnownConnectionAccess } from "@t3tools/client-runtime/j5/sharing";
import { create } from "zustand";

import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";

/** The asking thread whose right panel the Inbox shows, and the agent who asked. */
export interface InboxPanelThread {
  readonly ref: ScopedThreadRef;
  readonly agentLabel: string;
}

interface InboxThreadPanelState {
  /** The last panel shown, which the toggle reopens. `null` until a link in an ask opens one. */
  readonly shown: InboxPanelThread | null;
  /** The ask clicked last, with its thread's user-action count at the click. */
  readonly armed: (InboxPanelThread & { readonly revision: number }) | null;
}

export const useInboxThreadPanelStore = create<InboxThreadPanelState>(() => ({
  shown: null,
  armed: null,
}));

/**
 * Called on every click inside an ask, before its link handles it. A link that opens something in
 * the asking thread's panel, now or after a lookup, then shows that panel beside the Inbox.
 */
export function armInboxThreadPanel(thread: InboxPanelThread): void {
  const revision = useRightPanelStore.getState().getUserActionRevision(thread.ref);
  useInboxThreadPanelStore.setState({ armed: { ...thread, revision } });
}

/**
 * Shows the armed thread's panel once a user action opens it. Agent-driven and automatic opens
 * are not user actions, so they never pull a panel beside the Inbox.
 */
export function followInboxThreadPanelOpens(): () => void {
  return useRightPanelStore.subscribe((state) => {
    const { armed } = useInboxThreadPanelStore.getState();
    if (armed === null) return;
    const revision = state.userActionRevisionByThreadKey[scopedThreadKey(armed.ref)] ?? 0;
    if (revision === armed.revision) return;
    if (!selectThreadRightPanelState(state.byThreadKey, armed.ref).isOpen) return;
    useInboxThreadPanelStore.setState({
      shown: { ref: armed.ref, agentLabel: armed.agentLabel },
      armed: null,
    });
  });
}

/**
 * Whether links in an ask may use the asking thread's panel. The panel's browser needs a
 * Collaborator's level on the thread, so a narrowed person without one keeps the links of an ask
 * with no thread. A device the server cannot place yet, or a server that has not answered, is
 * treated as reaching the whole server until it says otherwise.
 */
export const reachesAskingThreadPanel = (
  access: KnownConnectionAccess,
  operable: boolean,
): boolean => access?.kind !== "person" || access.wide || operable;

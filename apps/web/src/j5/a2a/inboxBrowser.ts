import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { KnownConnectionAccess } from "@t3tools/client-runtime/j5/sharing";
import {
  type BrowserLinkTarget,
  type EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { type ResolveLinkTargetInput, resolveLinkTarget } from "../../browser/browserLinkTarget";
import { resolveStorage } from "../../lib/storage";

/**
 * The Inbox's own browser on each server: its tabs are preview sessions of a thread that does not
 * exist, so no agent's preview tools, which act on their own thread, list or drive them.
 */
const INBOX_BROWSER_THREAD_ID = ThreadId.make("j5-inbox-browser");

export const inboxBrowserRef = (environmentId: EnvironmentId): ScopedThreadRef =>
  scopeThreadRef(environmentId, INBOX_BROWSER_THREAD_ID);

/**
 * Whether a link in an Inbox message opens in the Inbox's browser: when the same link in a thread
 * would open in the thread's browser, and pull request links too. A connection narrower than the
 * server may drive previews only on threads it collaborates on, and a window too narrow for a pane
 * beside the asks has no room for one, so both open links as before.
 */
export function opensInInboxBrowser(input: {
  readonly url: string;
  readonly event: ResolveLinkTargetInput["event"];
  readonly preference: BrowserLinkTarget;
  readonly previewAvailable: boolean;
  readonly canOperatePreview: boolean;
  readonly access: KnownConnectionAccess;
  readonly sheetLayout: boolean;
}): boolean {
  const { access } = input;
  // `null` is no answer yet or a server from before people: nothing is withheld, as elsewhere.
  const wide =
    access === null || access.kind === "service" || (access.kind === "person" && access.wide);
  return (
    resolveLinkTarget({
      url: input.url,
      event: input.event,
      preference: input.preference,
      canOpenInApp: input.previewAvailable && input.canOperatePreview && wide && !input.sheetLayout,
    }) === "app"
  );
}

/** The server whose Inbox browser the page shows: the one a link was last opened on. */
interface InboxBrowserState {
  readonly environmentId: EnvironmentId | null;
}

export const useInboxBrowserStore = create<InboxBrowserState>()(
  persist((): InboxBrowserState => ({ environmentId: null }), {
    name: "j5:inbox-browser:v1",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
  }),
);

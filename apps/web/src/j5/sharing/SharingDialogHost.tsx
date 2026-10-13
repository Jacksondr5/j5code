import { useSyncExternalStore } from "react";

import { JoinLinkDialog } from "./JoinLinkDialog";
import { ShareDialog } from "./ShareDialog";
import { closeSharingDialog, sharingDialogStore } from "./sharingDialogs";

/** Draws whichever of sharing's dialogs was asked for. Mounted once, at the root. */
export function SharingDialogHost() {
  const { request, opening } = useSyncExternalStore(
    sharingDialogStore.subscribe,
    sharingDialogStore.read,
    sharingDialogStore.read,
  );
  if (request === null) return null;
  return request.kind === "share" ? (
    <ShareDialog
      key={opening}
      environmentId={request.environmentId}
      target={request.target}
      onClose={closeSharingDialog}
    />
  ) : (
    <JoinLinkDialog
      key={opening}
      environmentId={request.environmentId}
      threadId={request.threadId}
      onClose={closeSharingDialog}
    />
  );
}

import type { ScopedThreadRef } from "@t3tools/contracts";

import { refreshSquadronDirectory } from "./SquadronDirectory";
import { refreshThreadHomes } from "./ThreadHomesClient";

/**
 * A launch names no Squadron; the server puts the thread in its project's Squadron and may
 * create that Squadron. Re-read the thread's home and the directory so the new thread shows
 * while a Squadron filter is selected, and a Squadron the launch created appears in the filter.
 */
export function refreshAfterThreadLaunch(ref: ScopedThreadRef) {
  refreshThreadHomes([ref]);
  void refreshSquadronDirectory({ environmentId: ref.environmentId, force: true });
}

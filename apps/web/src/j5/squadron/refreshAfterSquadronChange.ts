import type { EnvironmentId } from "@t3tools/contracts";

import { refreshHumanInboxes } from "../a2a/HumanInboxPage";
import { notifyHumanInboxChanged } from "../a2a/humanInboxRefresh";
import { refreshFleet } from "../fleet/fleetClient";
import { refreshSquadronDirectory } from "./SquadronDirectory";
import { refreshRequestedThreadHomes } from "./ThreadHomesClient";

/**
 * Rename and delete change reads that carry the Squadron's name or rows: the directory, thread
 * homes, Fleet, and the inbox list and bell count. Resolves once the directory has re-read.
 */
export async function refreshAfterSquadronChange(environmentId: EnvironmentId) {
  await refreshSquadronDirectory({ environmentId, force: true });
  refreshRequestedThreadHomes();
  void refreshFleet();
  void refreshHumanInboxes(environmentId, true).catch(() => undefined);
  notifyHumanInboxChanged(environmentId);
}

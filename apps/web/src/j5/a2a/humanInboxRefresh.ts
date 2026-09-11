import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { inboxCountQueryAtom } from "../state";

/** The page and bell share the owning environment's query; no window-wide refresh broadcast. */
export function notifyHumanInboxChanged(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(inboxCountQueryAtom(environmentId));
}

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { canShareWithGuest } from "./guestShareAvailability";
import { GUEST_LINKS_OFFERED } from "../../j5/sharing/guestLinks";

/**
 * Whether this environment offers "Share with guest": the user may create links there, and its
 * Guest links beta is on (Settings > Labs). The server refuses links while the beta is off.
 * Guests arrive through T3 Connect, so a policy that turns Connect off hides sharing too.
 */
export function useCanShareWithGuest(environmentId: EnvironmentId | null): boolean {
  const permitted = useAtomValue(serverEnvironment.createGuestShare.permissionAtom(environmentId));
  const offered = useAtomValue(environmentServerConfigsAtom, (configs) =>
    canShareWithGuest(permitted, environmentId === null ? undefined : configs.get(environmentId)),
  );
  // J5: guest links are hidden, as on web (FORK.md case 92).
  return GUEST_LINKS_OFFERED && offered;
}

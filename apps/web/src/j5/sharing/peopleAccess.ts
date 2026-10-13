import { AuthAccessReadScope } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useIsGuest } from "./guestAccess";

/**
 * Whether Settings lists the People page: the primary server's connection holds upstream's
 * "access:read", which a guest's never does. The page itself checks again, and the server
 * answers the reads.
 */
export function useCanSeePeople(): boolean {
  return useEnvironmentScope(usePrimaryEnvironmentId(), AuthAccessReadScope);
}

// Upstream's Settings pages that only show a guest a failure: each asks the server for something
// a guest is not given. A guest who types one of their addresses still gets upstream's error.
const HIDDEN_FROM_A_GUEST: ReadonlySet<string> = new Set([
  "/settings/scheduled-tasks",
  "/settings/source-control",
  "/settings/archived",
]);

/**
 * Whether Settings lists a section for the primary server's connection. Everything is listed
 * for a member, People only for a connection that can see who is on the server, and a guest is
 * not offered the pages that could only fail for them. Upstream's nav asks this one question.
 */
export function useSettingsNavShown(): (path: string) => boolean {
  const canSeePeople = useCanSeePeople();
  const isGuest = useIsGuest(usePrimaryEnvironmentId());
  return (path) =>
    path === "/settings/people" ? canSeePeople : !(isGuest && HIDDEN_FROM_A_GUEST.has(path));
}

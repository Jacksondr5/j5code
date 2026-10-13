import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { j5Sharing } from "./guestAccess";

// The server tells a member's connection the owner's name once, when it connects. A name set or
// changed from this client afterwards is kept here, so the client does not ask for it again
// before the next connection is told the new one.
const setHere = new Map<EnvironmentId, string>();
// Servers this client was told "Not now" for. Kept only until the client is closed, so the
// question comes back at the next start.
const notNow = new Set<EnvironmentId>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const readVersion = () => version;

export function rememberOwnerName(environmentId: EnvironmentId, name: string) {
  setHere.set(environmentId, name);
  changed();
}

export function askForOwnerNameLater(environmentId: EnvironmentId) {
  notNow.add(environmentId);
  changed();
}

const NOT_TOLD = Atom.make<string | null | undefined>(undefined);

/**
 * The name of the person a server belongs to: a name, `null` when none is set yet, and
 * `undefined` when this connection was not told (the server has not answered, the connection is
 * a guest's, or the server is from before owners had names).
 */
export function useOwnerName(environmentId: EnvironmentId | null): string | null | undefined {
  useSyncExternalStore(subscribe, readVersion, readVersion);
  const told = useAtomValue(environmentId === null ? NOT_TOLD : j5Sharing.ownerName(environmentId));
  return environmentId === null ? undefined : (setHere.get(environmentId) ?? told);
}

/** Whether "Not now" was chosen for a server since this client was opened. */
export function useOwnerNameAskedLater(): ReadonlySet<EnvironmentId> {
  useSyncExternalStore(subscribe, readVersion, readVersion);
  return notNow;
}

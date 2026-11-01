import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../../state/atom-registry";
import { workspaceConnections } from "../../state/workspace";

const RECONNECT_WAIT_MS = 15_000;

/** Resolves true once the environment reports connected, false after the wait runs out. */
export function waitForEnvironmentConnected(environmentId: EnvironmentId): Promise<boolean> {
  const connected = () =>
    appAtomRegistry
      .get(workspaceConnections.environmentsAtom)
      .some(
        (environment) =>
          environment.environmentId === environmentId &&
          environment.connectionState === "connected",
      );
  if (connected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), RECONNECT_WAIT_MS);
    const unsubscribe = appAtomRegistry.subscribe(workspaceConnections.environmentsAtom, () => {
      if (connected()) finish(true);
    });
  });
}

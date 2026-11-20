import type { ParticipantIdentities } from "@t3tools/client-runtime/j5/participant-identity";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useWorkspaceEnvironments } from "../../state/workspace";
import { connectionMemory, type MemorySnapshot } from "../connection/memory";

export const NO_IDENTITIES: ParticipantIdentities = { labels: new Map(), threads: new Map() };
const NO_ONE: ReadonlySet<string> = new Set();

export interface ScreenIdentities extends ParticipantIdentities {
  /** Participants whose name is on its way: say nothing for them yet rather than a fallback. */
  readonly pending: ReadonlySet<string>;
}

/** Ids a connected server has not answered for yet and has no remembered name for. */
export const pendingParticipants = (
  snapshot: MemorySnapshot,
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
  connected: boolean,
): ReadonlySet<string> => {
  if (!connected) return NO_ONE;
  const heard = snapshot.heard.get(environmentId);
  const labels = snapshot.memory.get(environmentId)?.names.labels;
  const pending = participantIds.filter((id) => !heard?.has(id) && !labels?.has(id));
  return pending.length === 0 ? NO_ONE : new Set(pending);
};

export const useConnectedEnvironmentIds = (): ReadonlySet<EnvironmentId> => {
  const environments = useWorkspaceEnvironments();
  const key = environments
    .flatMap((environment) =>
      environment.connectionState === "connected" ? [environment.environmentId] : [],
    )
    .sort()
    .join("\n");
  return useMemo(() => new Set(key === "" ? [] : (key.split("\n") as Array<EnvironmentId>)), [key]);
};

/**
 * Names for the ids on screen, kept per server and paired credential, so a revisit or a new
 * sender never drops the names already shown. Each id is asked once a connection; a read sent
 * before the environment connects fails, so it waits for the connection.
 */
export function useParticipantIdentities(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
): ScreenIdentities {
  const idsKey = Array.from(new Set(participantIds)).sort().join("\0");
  const connected = useConnectedEnvironmentIds().has(environmentId);
  const snapshot = useSyncExternalStore(
    connectionMemory.subscribe,
    connectionMemory.getSnapshot,
    connectionMemory.getSnapshot,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for names of the ids on screen it has not named this connection.
  useEffect(() => {
    if (idsKey === "" || !connected) return;
    void connectionMemory.readNames(environmentId, idsKey.split("\0"));
  }, [connected, environmentId, idsKey]);
  const names = snapshot.memory.get(environmentId)?.names ?? NO_IDENTITIES;
  const pendingKey = [
    ...pendingParticipants(
      snapshot,
      environmentId,
      idsKey === "" ? [] : idsKey.split("\0"),
      connected,
    ),
  ].join("\0");
  const pending = useMemo(
    () => (pendingKey === "" ? NO_ONE : new Set(pendingKey.split("\0"))),
    [pendingKey],
  );
  return useMemo(() => ({ ...names, pending }), [names, pending]);
}

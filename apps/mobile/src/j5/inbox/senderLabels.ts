import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { pendingParticipants } from "../a2a/participantIdentities";
import { connectionMemory } from "../connection/memory";

export interface ScopedParticipantRef {
  readonly environmentId: EnvironmentId;
  readonly participantId: string;
  readonly connected: boolean;
}

export interface ScopedParticipantLabels {
  readonly labels: ReadonlyMap<EnvironmentId, ReadonlyMap<string, string>>;
  /** Whether the sender's name is still on its way from its connected server. */
  readonly isPending: (environmentId: EnvironmentId, participantId: string) => boolean;
}

/**
 * Names for senders spread across servers, as web's merged inbox reads them: each connected
 * server names its own senders once a connection, and the names are kept per server and paired
 * credential, so a revisit shows them on its first frame.
 */
export function useScopedParticipantLabels(
  refs: ReadonlyArray<ScopedParticipantRef>,
): ScopedParticipantLabels {
  const key = Array.from(
    new Set(
      refs
        .filter((ref) => ref.connected)
        .map((ref) => JSON.stringify([ref.environmentId, ref.participantId])),
    ),
  )
    .sort()
    .join("\n");
  const snapshot = useSyncExternalStore(
    connectionMemory.subscribe,
    connectionMemory.getSnapshot,
    connectionMemory.getSnapshot,
  );
  const byEnvironment = useMemo(() => {
    const ids = new Map<EnvironmentId, Array<string>>();
    for (const entry of key === "" ? [] : key.split("\n")) {
      const [environmentId, participantId] = JSON.parse(entry) as [EnvironmentId, string];
      ids.set(environmentId, [...(ids.get(environmentId) ?? []), participantId]);
    }
    return ids;
  }, [key]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks each server for the senders on screen it has not named this connection.
  useEffect(() => {
    for (const [environmentId, ids] of byEnvironment)
      void connectionMemory.readNames(environmentId, ids);
  }, [byEnvironment]);
  return useMemo(
    () => ({
      labels: new Map(
        [...snapshot.memory].map(([environmentId, connection]) => [
          environmentId,
          connection.names.labels,
        ]),
      ),
      isPending: (environmentId: EnvironmentId, participantId: string) =>
        pendingParticipants(
          snapshot,
          environmentId,
          [participantId],
          byEnvironment.has(environmentId),
        ).size > 0,
    }),
    [snapshot, byEnvironment],
  );
}

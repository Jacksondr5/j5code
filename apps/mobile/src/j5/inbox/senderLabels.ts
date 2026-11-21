import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { connectionMemory, namesExpectedAtom } from "../connection/memory";
import { pendingParticipants } from "../connection/memory.logic";

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
 * server names its own senders as the Inbox opens or reconnects, and the names are kept per
 * server and paired credential, so a revisit shows them on its first frame.
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
  const { names, settled } = useSyncExternalStore(
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads each server's names for the senders on screen, again as they connect.
  useEffect(() => {
    for (const [environmentId, ids] of byEnvironment)
      void connectionMemory.readNames(environmentId, ids);
  }, [byEnvironment]);
  // Keyed on the names alone, so a classification answer does not re-render the cards.
  const labels = useMemo(
    () => new Map([...names].map(([environmentId, known]) => [environmentId, known.labels])),
    [names],
  );
  // Every sender on screen, through a re-pair's first connection too: a name on its way shows none.
  const expected = useAtomValue(namesExpectedAtom);
  const pendingKey = refs
    .flatMap((ref) =>
      pendingParticipants(
        names,
        settled,
        ref.environmentId,
        [ref.participantId],
        expected.has(ref.environmentId),
      ).size > 0
        ? [JSON.stringify([ref.environmentId, ref.participantId])]
        : [],
    )
    .sort()
    .join("\n");
  return useMemo(() => {
    const pending = new Set(pendingKey === "" ? [] : pendingKey.split("\n"));
    return {
      labels,
      isPending: (environmentId: EnvironmentId, participantId: string) =>
        pending.has(JSON.stringify([environmentId, participantId])),
    };
  }, [labels, pendingKey]);
}

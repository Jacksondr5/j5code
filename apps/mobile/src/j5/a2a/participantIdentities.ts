import { useAtomValue } from "@effect/atom-react";
import type { ParticipantIdentities } from "@t3tools/client-runtime/j5/participant-identity";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useWorkspaceEnvironments } from "../../state/workspace";
import { connectionMemory, namesExpectedAtom } from "../connection/memory";
import { pendingParticipants } from "../connection/memory.logic";

export const NO_IDENTITIES: ParticipantIdentities = { labels: new Map(), threads: new Map() };
const NO_ONE: ReadonlySet<string> = new Set();

export interface ScreenIdentities extends ParticipantIdentities {
  /** Participants whose name is on its way: say nothing for them yet rather than a fallback. */
  readonly pending: ReadonlySet<string>;
}

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
 * sender never drops the names already shown. They are read again as the screen mounts or
 * reconnects; a read sent before the environment connects fails, so it waits for the connection.
 */
export function useParticipantIdentities(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
): ScreenIdentities {
  const idsKey = Array.from(new Set(participantIds)).sort().join("\0");
  const connected = useConnectedEnvironmentIds().has(environmentId);
  // Through a re-pair's first connection too, so the line never swaps a stand-in for the name.
  const expected = useAtomValue(namesExpectedAtom).has(environmentId);
  const {
    memory,
    names: known,
    settled,
  } = useSyncExternalStore(
    connectionMemory.subscribe,
    connectionMemory.getSnapshot,
    connectionMemory.getSnapshot,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the names of the ids on screen from the server, again on each connection.
  useEffect(() => {
    if (idsKey === "" || !connected) return;
    void connectionMemory.readNames(environmentId, idsKey.split("\0"));
  }, [connected, environmentId, idsKey]);
  const names = known.get(environmentId) ?? NO_IDENTITIES;
  const pendingKey = [
    ...pendingParticipants(
      memory,
      settled,
      environmentId,
      idsKey === "" ? [] : idsKey.split("\0"),
      expected,
    ),
  ].join("\0");
  const pending = useMemo(
    () => (pendingKey === "" ? NO_ONE : new Set(pendingKey.split("\0"))),
    [pendingKey],
  );
  return useMemo(() => ({ ...names, pending }), [names, pending]);
}

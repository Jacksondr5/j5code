import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { environmentSession } from "../../state/session";
import { requestCrewMemberships } from "../crew/CrewMembershipsClient";
import { requestSpawnedChildren } from "./SpawnedChildrenClient";

/** Each catalogued environment's prepared connection, or null while it is not connected. */
export const threadReadConnectionsAtom = Atom.make((get) => {
  const connections = new Map<EnvironmentId, PreparedConnection | null>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const state = Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(id))));
    const prepared = get(environmentSession.preparedConnectionValueAtom(id));
    connections.set(id, state?.phase === "connected" ? Option.getOrNull(prepared) : null);
  }
  return connections;
});

/**
 * Keeps the Crew chips and spawned children of the sidebar's rows read. Incremental: only rows
 * not yet answered for are fetched here, and the Fleet poll re-reads the involved rows on its own
 * cadence. `ThreadCardIdentity` and `SpawnedChildren` render what these reads return.
 */
export function useThreadRowReads(refs: ReadonlyArray<ScopedThreadRef>) {
  const key = JSON.stringify(refs);
  const requested = useMemo(() => JSON.parse(key) as ReadonlyArray<ScopedThreadRef>, [key]);
  const connections = useAtomValue(threadReadConnectionsAtom);
  useEffect(() => {
    requestCrewMemberships(requested, connections);
    requestSpawnedChildren(requested, connections);
  }, [connections, requested]);
}

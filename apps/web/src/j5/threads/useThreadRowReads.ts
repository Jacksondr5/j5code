import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { takeMovedRevisions } from "@t3tools/client-runtime/j5/scopedThreadReadStore";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { environmentSession } from "../../state/session";
import { requestCrewMemberships } from "../crew/CrewMembershipsClient";
import { j5Environment, j5Sharing } from "../state";
import { requestSpawnedChildren } from "./SpawnedChildrenClient";

/**
 * Each catalogued environment's prepared connection, or null while it is not connected. A person
 * who reaches less than the whole server is answered for what they reach.
 */
const threadReadConnectionsAtom = Atom.make((get) => {
  const connections = new Map<EnvironmentId, PreparedConnection | null>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const state = Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(id))));
    const prepared = get(environmentSession.preparedConnectionValueAtom(id));
    connections.set(id, state?.phase === "connected" ? Option.getOrNull(prepared) : null);
  }
  return connections;
});

/**
 * The Crew, Fleet and sharing revisions of each server where the person reaches less than all of
 * it. The Fleet roster bounds everyone else's re-reads (`useFleetRefresh`), but it is the server's
 * own read, so these servers re-read the rows on screen when a revision moves. Sharing is there
 * because a level that goes can take a child's spawner out of reach.
 */
const narrowPlacementRevisionsAtom = Atom.make((get) => {
  const revisions: Array<readonly [EnvironmentId, string | null]> = [];
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys())
    if (get(j5Sharing.isNarrow(id)))
      revisions.push([
        id,
        get(j5Environment.rereadOn("crew", "fleet", "sharing")({ environmentId: id })),
      ]);
  return JSON.stringify(revisions);
});

const heardRevisions = new Map<EnvironmentId, string>();

/**
 * Keeps the Crew chips and spawned children of the sidebar's rows read. Incremental: only rows
 * not yet answered for are fetched here, and a Crew or Fleet change re-reads the involved rows
 * (`useFleetRefresh`). `ThreadCardIdentity` and `SpawnedChildren` render what these reads return.
 */
export function useThreadRowReads(refs: ReadonlyArray<ScopedThreadRef>) {
  const connections = useAtomValue(threadReadConnectionsAtom);
  const narrowRevisions = useAtomValue(narrowPlacementRevisionsAtom);
  // The sidebar's list spans every thread and re-renders while a turn streams, so the effect keys
  // on the serialized row set instead of the list's identity.
  const key = JSON.stringify(refs);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the servers for Crew chips and spawned children of the rows on screen, batched across rows, again where a narrow person's placements moved.
  useEffect(() => {
    const requested = JSON.parse(key) as ReadonlyArray<ScopedThreadRef>;
    requestCrewMemberships(requested, connections);
    requestSpawnedChildren(requested, connections);
    const moved = takeMovedRevisions(
      heardRevisions,
      JSON.parse(narrowRevisions) as Array<[EnvironmentId, string | null]>,
    );
    if (moved.size === 0) return;
    const rows = requested.filter((ref) => moved.has(ref.environmentId));
    requestCrewMemberships(rows, connections, true);
    requestSpawnedChildren(rows, connections, true);
  }, [connections, key, narrowRevisions]);
}

import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createScopedThreadReadStore } from "@t3tools/client-runtime/j5/scopedThreadReadStore";
import {
  isSidebarMember,
  replaceSpawnedChildren,
  spawnedChildrenRows,
  type SpawnedChildrenRow,
  type SpawnedChildrenRowEntry,
} from "@t3tools/client-runtime/j5/spawned-children";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { SpawnedChild } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";

const store = createScopedThreadReadStore<SpawnedChildrenRow, SpawnedChildrenRowEntry>({
  load: async (environmentId, threadIds) => {
    const result = await j5Environment.listSpawnedChildren.run(appAtomRegistry, {
      environmentId,
      input: { threadIds },
    });
    if (result._tag === "Failure") throw Cause.squash(result.cause);
    return spawnedChildrenRows(result.value);
  },
  replace: replaceSpawnedChildren,
});

/**
 * Each catalogued environment's prepared connection, or null while it is not connected or the
 * person reaches less than the whole server, which refuses these reads (web's `useThreadRowReads`).
 */
const threadReadConnectionsAtom = Atom.make((get) => {
  const connections = new Map<EnvironmentId, PreparedConnection | null>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const state = Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(id))));
    const prepared = get(environmentSession.preparedConnectionValueAtom(id));
    const readable = state?.phase === "connected" && !get(j5Sharing.isNarrow(id));
    connections.set(id, readable ? Option.getOrNull(prepared) : null);
  }
  return connections;
}).pipe(Atom.withLabel("mobile-j5:spawned-children-connections"));

/** Each environment's Crew and Fleet revisions; a moved pair means placements may have changed. */
const placementRevisionsAtom = Atom.make((get) => {
  const revisions: Array<readonly [EnvironmentId, string | null]> = [];
  for (const id of get(threadReadConnectionsAtom).keys())
    revisions.push([id, get(j5Environment.rereadOn("crew", "fleet")({ environmentId: id }))]);
  return JSON.stringify(revisions);
}).pipe(Atom.withLabel("mobile-j5:placement-revisions"));

// Shared by every list that mounts the hook, so two lists re-read a moved environment once.
const heardRevisions = new Map<EnvironmentId, string>();

/**
 * Mobile has no Fleet roster to bound re-reads by, so a moved revision re-reads that
 * environment's listed rows: one batched read, whose reply names only rows with children.
 */
const requestRows = (refs: ReadonlyArray<ScopedThreadRef>, revisions: string) => {
  store.request(refs);
  const moved = new Set<EnvironmentId>();
  for (const [environmentId, revision] of JSON.parse(revisions) as Array<
    [EnvironmentId, string | null]
  >) {
    if (revision === null || heardRevisions.get(environmentId) === revision) continue;
    heardRevisions.set(environmentId, revision);
    moved.add(environmentId);
  }
  if (moved.size > 0)
    store.request(
      refs.filter((ref) => moved.has(ref.environmentId)),
      true,
    );
};

/**
 * The list's threads without the ones an agent spawned (register D22): those show under their
 * spawner's row unless pinned. Also keeps the spawned-children read current for every thread.
 */
export function useCrewListedThreads<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly archivedAt: string | null;
    readonly pinnedAt?: string | null | undefined;
  },
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  const connections = useAtomValue(threadReadConnectionsAtom);
  const revisions = useAtomValue(placementRevisionsAtom);
  // The list re-renders while turns stream, so the effect keys on the serialized row set.
  const key = JSON.stringify(
    threads.flatMap((thread) =>
      thread.archivedAt === null ? [[thread.environmentId, thread.id]] : [],
    ),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the servers which listed threads have agents under them or were spawned by one, again when placements change.
  useEffect(() => {
    store.setConnections(connections);
    const refs = (JSON.parse(key) as Array<[EnvironmentId, ThreadId]>).map(
      ([environmentId, threadId]) => scopeThreadRef(environmentId, threadId),
    );
    requestRows(refs, revisions);
  }, [connections, key, revisions]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(
    () =>
      threads.filter((thread) =>
        isSidebarMember(
          thread,
          snapshot.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
            ?.spawnedByAgent === true,
        ),
      ),
    [threads, snapshot],
  );
}

const EMPTY: ReadonlyArray<SpawnedChild> = [];

/** The agents placed under one thread, as last read. */
export function useSpawnedChildren(ref: ScopedThreadRef): ReadonlyArray<SpawnedChild> {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return snapshot.get(scopedThreadKey(ref))?.children ?? EMPTY;
}

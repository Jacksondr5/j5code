import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createScopedThreadReadStore,
  takeMovedRevisions,
} from "@t3tools/client-runtime/j5/scopedThreadReadStore";
import {
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
import type { WorkspaceState } from "../../state/workspaceModel";
import { answerExpectedAtom, connectionMemory } from "../connection/memory";
import { crewListedThreads, crewListWaiting, type ListedThread } from "../connection/memory.logic";
import { j5Environment } from "../state";

const store = createScopedThreadReadStore<SpawnedChildrenRow, SpawnedChildrenRowEntry>({
  load: async (environmentId, threadIds) => {
    const ticket = connectionMemory.ticketOf(environmentId);
    const result = await j5Environment.listSpawnedChildren.run(appAtomRegistry, {
      environmentId,
      input: { threadIds },
    });
    if (result._tag === "Failure") {
      connectionMemory.spawnedReadFailed(environmentId);
      throw Cause.squash(result.cause);
    }
    if (ticket !== null)
      connectionMemory.rememberSpawned(
        environmentId,
        ticket,
        threadIds,
        result.value.spawnedByAgent,
      );
    return spawnedChildrenRows(result.value);
  },
  replace: replaceSpawnedChildren,
});

/**
 * Each catalogued environment's prepared connection, or null while it is not connected. A person
 * who reaches less than the whole server is answered for what they reach.
 */
export const threadReadConnectionsAtom = Atom.make((get) => {
  const connections = new Map<EnvironmentId, PreparedConnection | null>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const state = Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(id))));
    const prepared = get(environmentSession.preparedConnectionValueAtom(id));
    connections.set(id, state?.phase === "connected" ? Option.getOrNull(prepared) : null);
  }
  return connections;
}).pipe(Atom.withLabel("mobile-j5:thread-read-connections"));

/**
 * Each environment's Crew, Fleet and sharing revisions: placements, or what the person reaches of
 * them (a level that goes can take a child's spawner out of reach), may have changed.
 */
const placementRevisionsAtom = Atom.make((get) => {
  const revisions: Array<readonly [EnvironmentId, string | null]> = [];
  for (const id of get(threadReadConnectionsAtom).keys())
    revisions.push([
      id,
      get(j5Environment.rereadOn("crew", "fleet", "sharing")({ environmentId: id })),
    ]);
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
  const moved = takeMovedRevisions(
    heardRevisions,
    JSON.parse(revisions) as Array<[EnvironmentId, string | null]>,
  );
  if (moved.size > 0)
    store.request(
      refs.filter((ref) => moved.has(ref.environmentId)),
      true,
    );
};

/** The remembered answers, and the servers whose answer is on its way (a failed read is not). */
const useAnswers = () => {
  const expected = useAtomValue(answerExpectedAtom);
  const { memory, failedReads } = useSyncExternalStore(
    connectionMemory.subscribe,
    connectionMemory.getSnapshot,
    connectionMemory.getSnapshot,
  );
  const answerExpected = useMemo(
    () => new Set([...expected].filter((id) => !failedReads.has(id))),
    [expected, failedReads],
  );
  return { memory, answerExpected };
};

/**
 * The list's threads without the ones an agent spawned (register D22): those show in their
 * spawner's Agents sheet unless pinned. Each answer is remembered for the connection, so the
 * list's first paint already leaves them out. Also keeps the spawned-children read current.
 */
export function useCrewListedThreads<T extends ListedThread>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const connections = useAtomValue(threadReadConnectionsAtom);
  const revisions = useAtomValue(placementRevisionsAtom);
  const { memory, answerExpected } = useAnswers();
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
  return useMemo(
    () => crewListedThreads(threads, memory, answerExpected),
    [threads, memory, answerExpected],
  );
}

/**
 * Whether the list is empty only because its threads wait for their first spawned-children
 * answer (a first launch or new pairing), so it shows upstream's loading state, not "No threads".
 */
export function useCrewListWaiting(threads: ReadonlyArray<ListedThread>): boolean {
  const { memory, answerExpected } = useAnswers();
  return useMemo(
    () => crewListWaiting(threads, memory, answerExpected),
    [threads, memory, answerExpected],
  );
}

/** The workspace as upstream's "Connecting to environment" loading state reads it. */
export const connectingWorkspace = (state: WorkspaceState): WorkspaceState => ({
  ...state,
  connectionState: "connecting",
  hasConnectingEnvironment: true,
  hasLoadedShellSnapshot: false,
  connectionError: null,
});

const EMPTY: ReadonlyArray<SpawnedChild> = [];

/**
 * The agents placed under one open thread. It is read on open and again when placements change,
 * so it stays current even when no list has the thread on screen.
 */
export function useThreadSpawnedChildren(ref: ScopedThreadRef | null): ReadonlyArray<SpawnedChild> {
  const environmentId = ref?.environmentId;
  const threadId = ref?.threadId;
  // Subscribed here rather than read in render, so a revision on any server doesn't re-render
  // the thread screen; only this thread's server's placements re-read it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the thread's server for the agents under it, again when its connection or placements change.
  useEffect(() => {
    if (environmentId === undefined || threadId === undefined) return;
    const target = scopeThreadRef(environmentId, threadId);
    const read = () => {
      store.setConnections(appAtomRegistry.get(threadReadConnectionsAtom));
      store.request([target], true);
    };
    read();
    const offConnections = appAtomRegistry.subscribe(threadReadConnectionsAtom, read);
    const offPlacements = appAtomRegistry.subscribe(
      j5Environment.rereadOn("crew", "fleet", "sharing")({ environmentId }),
      read,
    );
    return () => {
      offConnections();
      offPlacements();
    };
  }, [environmentId, threadId]);
  const key = ref === null ? null : scopedThreadKey(ref);
  const read = () => (key === null ? EMPTY : (store.getSnapshot().get(key)?.children ?? EMPTY));
  return useSyncExternalStore(store.subscribe, read, read);
}

import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createScopedThreadReadStore } from "@t3tools/client-runtime/j5/scopedThreadReadStore";
import {
  replaceSpawnedChildren,
  spawnedChildrenRows,
  type SpawnedChildrenRow,
  type SpawnedChildrenRowEntry,
} from "@t3tools/client-runtime/j5/spawned-children";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { SpawnedChild } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

export type { SpawnedChild } from "@t3tools/contracts/j5";

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

/** Incremental, from `useThreadRowReads`; a Crew or Fleet change re-reads the involved rows. */
export const requestSpawnedChildren = (
  refs: ReadonlyArray<ScopedThreadRef>,
  connections: ReadonlyMap<EnvironmentId, PreparedConnection | null>,
  force = false,
) => {
  store.setConnections(connections);
  store.request(refs, force);
};

/**
 * The re-read a Crew or Fleet change causes: the rows the roster says have placed children or sit in a Crew, plus
 * every row still showing children, so a parent whose children all archived loses them.
 */
export const refreshSpawnedChildrenRows = (refs: ReadonlyArray<ScopedThreadRef>) =>
  store.refreshRows(refs, { held: true });

const EMPTY: ReadonlyArray<SpawnedChild> = [];

export function useSpawnedChildren(ref: ScopedThreadRef): ReadonlyArray<SpawnedChild> {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return snapshot.get(scopedThreadKey(ref))?.children ?? EMPTY;
}

/** The scoped keys of the rows an agent spawned, for the sidebar's membership rule. */
export function useAgentSpawnedThreadKeys(): ReadonlySet<string> {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return new Set([...snapshot].flatMap(([key, row]) => (row.spawnedByAgent ? [key] : [])));
}

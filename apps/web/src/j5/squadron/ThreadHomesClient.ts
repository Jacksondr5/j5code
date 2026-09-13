import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { listThreadHomes as listThreadHomesEffect } from "@t3tools/client-runtime/j5/http";
import { createThreadHomesStore } from "@t3tools/client-runtime/j5/threadHomes";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { ScopedSquadronRef } from "@t3tools/contracts/j5";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSession } from "../../state/session";

export type { ThreadHome, ThreadHomeEntry } from "@t3tools/contracts/j5";
export type { ThreadHomesScopeReadState } from "@t3tools/client-runtime/j5/threadHomes";
export { replaceThreadHomeEntries } from "@t3tools/client-runtime/j5/threadHomes";
export {
  J5HttpError as ThreadHomesHttpError,
  listThreadHomes as listThreadHomesEffect,
} from "@t3tools/client-runtime/j5/http";

const connectionsAtom = Atom.make((get) => {
  const connections = new Map<EnvironmentId, PreparedConnection | null>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const state = Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(id))));
    const prepared = get(environmentSession.preparedConnectionValueAtom(id));
    connections.set(id, state?.phase === "connected" ? Option.getOrNull(prepared) : null);
  }
  return connections;
});

const store = createThreadHomesStore((prepared, ids) =>
  runtime.runPromise(listThreadHomesEffect(prepared, ids)),
);

const requestThreadHomes = (refs: ReadonlyArray<ScopedThreadRef>, force = false) => {
  store.setConnections(appAtomRegistry.get(connectionsAtom));
  store.request(refs, force);
};

export const refreshThreadHomes = (refs: ReadonlyArray<ScopedThreadRef>) =>
  requestThreadHomes(refs, true);
export const retryScopedThreadHomes = refreshThreadHomes;
export const shouldRequestThreadHome = (home: unknown, force: boolean) =>
  force || home === undefined;
export const shouldForceThreadHomesForScope = (scope: ScopedSquadronRef | null) => scope !== null;

export function useThreadHomesScopeReadState(scope: ScopedSquadronRef | null = null) {
  return useSyncExternalStore(store.subscribe, () =>
    store.getScopeReadState(scope?.environmentId ?? null),
  );
}

/** Incremental home reads follow the thread's environment; existing shared thread state is unchanged. */
export function useThreadHomes(
  refs: ReadonlyArray<ScopedThreadRef>,
  scope: ScopedSquadronRef | null = null,
  scopeSelectionGeneration = 0,
) {
  const key = JSON.stringify(refs);
  const requested = useMemo(() => JSON.parse(key) as ReadonlyArray<ScopedThreadRef>, [key]);
  const requestedRef = useRef(requested);
  requestedRef.current = requested;
  const connections = useAtomValue(connectionsAtom);
  const homes = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    store.setConnections(connections);
    store.request(requested);
  }, [connections, requested]);
  useEffect(() => {
    if (scope !== null)
      store.request(
        requestedRef.current.filter((ref) => ref.environmentId === scope.environmentId),
        true,
      );
  }, [scope, scopeSelectionGeneration]);
  return useMemo(
    () =>
      new Map(
        requested.flatMap((ref) => {
          const key = scopedThreadKey(ref);
          const home = homes.get(key);
          return home === undefined ? [] : [[key, home] as const];
        }),
      ),
    [homes, requested],
  );
}

import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { listThreadHomes } from "@t3tools/client-runtime/j5/http";
import { createThreadHomesStore } from "@t3tools/client-runtime/j5/threadHomes";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { runtime } from "../../lib/runtime";
import { threadReadConnectionsAtom, type KeyedThreadRefs } from "../threads/useThreadRowReads";

const store = createThreadHomesStore((prepared, ids) =>
  runtime.runPromise(listThreadHomes(prepared, ids)),
);

/**
 * Each listed thread's Squadron home, read incrementally from the thread's own environment. The
 * sidebar reads it only for `origin`, the placement provenance its membership rule needs
 * (register D22).
 */
export function useThreadHomes({ refs: requested }: KeyedThreadRefs) {
  const connections = useAtomValue(threadReadConnectionsAtom);
  const homes = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    store.setConnections(connections);
    store.request(requested);
  }, [connections, requested]);
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

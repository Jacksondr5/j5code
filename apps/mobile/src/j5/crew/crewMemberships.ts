import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { replaceCrewMemberships } from "@t3tools/client-runtime/j5/crew-memberships";
import { createScopedThreadReadStore } from "@t3tools/client-runtime/j5/scopedThreadReadStore";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { CrewMembershipEntry, ThreadCrewMembership } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { j5Environment } from "../state";
import { threadReadConnectionsAtom } from "./spawnedChildren";

const store = createScopedThreadReadStore<ThreadCrewMembership, CrewMembershipEntry>({
  load: async (environmentId, threadIds) => {
    const result = await j5Environment.listCrewMemberships.run(appAtomRegistry, {
      environmentId,
      input: { threadIds },
    });
    if (result._tag === "Failure") throw Cause.squash(result.cause);
    return result.value.entries;
  },
  replace: replaceCrewMemberships,
});

const NO_REVISION = Atom.make<string | null>(null).pipe(
  Atom.withLabel("mobile-j5:no-crew-revision"),
);

/**
 * One thread's Crew membership, read when it is first shown and again whenever its server says
 * a Crew changed, so a thread that becomes a Captain while open learns it. Undefined until read,
 * and for a thread in no Crew.
 */
export function useCrewMembership(
  ref: ScopedThreadRef | undefined,
): ThreadCrewMembership | undefined {
  const connections = useAtomValue(threadReadConnectionsAtom);
  const environmentId = ref?.environmentId;
  const threadId = ref?.threadId;
  const crewRevision = useAtomValue(
    environmentId === undefined ? NO_REVISION : j5Environment.rereadOn("crew")({ environmentId }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for this thread's Crew membership, and again when its Crew revision moves.
  useEffect(() => {
    store.setConnections(connections);
    if (environmentId !== undefined && threadId !== undefined)
      store.request([scopeThreadRef(environmentId, threadId)], true);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a moved Crew revision re-reads the membership.
  }, [connections, crewRevision, environmentId, threadId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return ref === undefined ? undefined : snapshot.get(scopedThreadKey(ref));
}

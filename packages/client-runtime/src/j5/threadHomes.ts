import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadHome, ThreadHomeEntry } from "@t3tools/contracts/j5";

import type { PreparedConnection } from "../connection/model.ts";
import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import {
  createScopedThreadReadStore,
  type ScopedThreadReadState,
} from "./scopedThreadReadStore.ts";

export type ThreadHomesScopeReadState = ScopedThreadReadState;

export const replaceThreadHomeEntries = (
  homes: ReadonlyMap<string, ThreadHome>,
  environmentId: EnvironmentId,
  entries: ReadonlyArray<ThreadHomeEntry>,
) => {
  const next = new Map(homes);
  for (const entry of entries)
    next.set(scopedThreadKey(scopeThreadRef(environmentId, entry.threadId)), entry.home);
  return next;
};

/**
 * Homes never go away, so a batch only adds and updates; a thread the batch did not mention
 * keeps whatever home it had.
 */
export function createThreadHomesStore(
  load: (
    prepared: PreparedConnection,
    threadIds: ReadonlyArray<ThreadId>,
  ) => Promise<ReadonlyArray<ThreadHomeEntry>>,
) {
  return createScopedThreadReadStore<ThreadHome, ThreadHomeEntry>({
    load,
    replace: (current, environmentId, _requested, entries) =>
      replaceThreadHomeEntries(current, environmentId, entries),
  });
}

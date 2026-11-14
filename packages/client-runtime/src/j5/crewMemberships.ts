import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { CrewMembershipEntry, ThreadCrewMembership } from "@t3tools/contracts/j5";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

/** The visible rows are the whole truth: a thread that left every Crew loses its chip on the next read. */
export const replaceCrewMemberships = (
  previous: ReadonlyMap<string, ThreadCrewMembership>,
  environmentId: EnvironmentId,
  requested: ReadonlyArray<ThreadId>,
  entries: ReadonlyArray<CrewMembershipEntry>,
) => {
  const next = new Map(previous);
  for (const threadId of requested)
    next.delete(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  for (const entry of entries)
    next.set(scopedThreadKey(scopeThreadRef(environmentId, entry.threadId)), entry.membership);
  return next;
};

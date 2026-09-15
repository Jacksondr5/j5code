import { formatCrewStateSummary, summarizeCrewState, type CrewSeatThread } from "../crew/crewState";
import type { SpawnedChild } from "./SpawnedChildrenClient";

export interface SpawnedChildThread extends CrewSeatThread {
  readonly id: string;
}

export interface SpawnedChildRow<T extends SpawnedChildThread> {
  readonly child: SpawnedChild;
  readonly thread: T;
}

/** Live children only, most recent first; a child whose thread is not yet in client state waits. */
export function selectSpawnedChildRows<T extends SpawnedChildThread>(
  children: ReadonlyArray<SpawnedChild>,
  threadsById: ReadonlyMap<string, T>,
): ReadonlyArray<SpawnedChildRow<T>> {
  return children
    .flatMap((child) => {
      const thread = threadsById.get(child.threadId);
      return thread === undefined || thread.archivedAt !== null ? [] : [{ child, thread }];
    })
    .toSorted((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt));
}

/** The collapsed row's discovery cue: a measured "needs a human" fact on any child. */
export const spawnedChildrenNeedAttention = <T extends SpawnedChildThread>(
  rows: ReadonlyArray<SpawnedChildRow<T>>,
) => rows.some(({ thread }) => thread.hasPendingApprovals || thread.hasPendingUserInput);

/**
 * "2 crew · 1 running · 1 settled" when every child is a Crew seat, so the Captain's row answers
 * "what is the state of this Crew?" from measured facts; "3 agents" otherwise, since crews and solo
 * peers mix as agents. Idle seats are the quiet default and stay unsaid.
 */
export const spawnedChildrenSummary = <T extends SpawnedChildThread>(
  rows: ReadonlyArray<SpawnedChildRow<T>>,
) => {
  const count = rows.length;
  if (count === 0) return null;
  const allSeats = rows.every(({ child }) => child.seat !== null);
  if (!allSeats) return `${count} ${count === 1 ? "agent" : "agents"}`;
  const state = formatCrewStateSummary(summarizeCrewState(rows.map(({ thread }) => thread)));
  return state === null ? `${count} crew` : `${count} crew · ${state}`;
};

const STORAGE_KEY = "j5:sidebar:spawned-children:expanded";

/** Expansion is remembered per parent thread so a Crew you watch stays open across reloads. */
export const readExpandedSpawnParents = (
  storage: Pick<Storage, "getItem"> | undefined,
): ReadonlySet<string> => {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [],
    );
  } catch {
    return new Set();
  }
};

export const writeExpandedSpawnParents = (
  storage: Pick<Storage, "setItem"> | undefined,
  expanded: ReadonlySet<string>,
) => {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...expanded]));
  } catch {
    // Storage may be unavailable (private mode, quota); expansion then lasts for the session.
  }
};

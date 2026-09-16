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

/** The collapsed header's discovery cue: a measured "needs a human" fact on any child. */
export const spawnedChildrenNeedAttention = <T extends SpawnedChildThread>(
  rows: ReadonlyArray<SpawnedChildRow<T>>,
) => rows.some(({ thread }) => thread.hasPendingApprovals || thread.hasPendingUserInput);

/**
 * One collapsible group under a Captain's row: a named Crew, or the solo Peer Agents it spawned
 * outside any Crew. A Captain that commands several Crews gets one group per Crew, so each can
 * be watched, opened, and named on its own.
 */
export interface SpawnedChildGroup<T extends SpawnedChildThread> {
  /** Stable within the parent: `crew:<instance>` for a Crew, `agents` for the solo peers. */
  readonly key: string;
  readonly crew: { readonly crewInstanceId: string; readonly crewName: string } | null;
  readonly rows: ReadonlyArray<SpawnedChildRow<T>>;
  /** "3 seats · 1 running · 1 needs you" for a Crew, "2 agents" for the solo group. */
  readonly summary: string;
  readonly needsAttention: boolean;
}

const SOLO_GROUP_KEY = "agents";
const crewGroupKey = (crewInstanceId: string) => `crew:${crewInstanceId}`;

/**
 * Crews first, the one with the newest seat activity on top, then the solo peers. Each Crew's
 * summary answers "what is the state of this Crew?" from its seats' measured facts; idle seats
 * are the quiet default and stay unsaid.
 */
export const groupSpawnedChildren = <T extends SpawnedChildThread>(
  rows: ReadonlyArray<SpawnedChildRow<T>>,
): ReadonlyArray<SpawnedChildGroup<T>> => {
  const crews = new Map<string, Array<SpawnedChildRow<T>>>();
  const solo: Array<SpawnedChildRow<T>> = [];
  for (const row of rows) {
    if (row.child.seat === null) solo.push(row);
    else {
      const seats = crews.get(row.child.seat.crewInstanceId) ?? [];
      seats.push(row);
      crews.set(row.child.seat.crewInstanceId, seats);
    }
  }
  // Rows arrive newest first, so each Crew's first seat carries its newest activity.
  const crewGroups = [...crews.entries()]
    .toSorted(([, left], [, right]) =>
      right[0]!.thread.updatedAt.localeCompare(left[0]!.thread.updatedAt),
    )
    .map(([crewInstanceId, seats]): SpawnedChildGroup<T> => {
      const state = formatCrewStateSummary(summarizeCrewState(seats.map(({ thread }) => thread)));
      const count = `${seats.length} ${seats.length === 1 ? "seat" : "seats"}`;
      return {
        key: crewGroupKey(crewInstanceId),
        crew: { crewInstanceId, crewName: seats[0]!.child.seat!.crewName },
        rows: seats,
        summary: state === null ? count : `${count} · ${state}`,
        needsAttention: spawnedChildrenNeedAttention(seats),
      };
    });
  if (solo.length === 0) return crewGroups;
  return [
    ...crewGroups,
    {
      key: SOLO_GROUP_KEY,
      crew: null,
      rows: solo,
      summary: `${solo.length} ${solo.length === 1 ? "agent" : "agents"}`,
      needsAttention: spawnedChildrenNeedAttention(solo),
    },
  ];
};

/** Expansion is remembered per group under its parent, so the Crew you watch stays open on reload. */
export const spawnedGroupExpansionKey = (parentThreadId: string, groupKey: string) =>
  `${parentThreadId}/${groupKey}`;

const STORAGE_KEY = "j5:sidebar:spawned-children:expanded";

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

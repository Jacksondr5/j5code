import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SpawnedChild, SpawnedChildrenEntry } from "@t3tools/contracts/j5";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import {
  crewHasRunningSeat,
  formatCrewStateSummary,
  summarizeCrewState,
  type CrewSeatThread,
} from "./crewState.ts";

/**
 * List membership (register D22): human-created agents show; agent-spawned Peer Agents (Crew
 * members included) appear under their spawner unless the user pinned them. `spawnedByAgent` is
 * the spawned-children read's statement of placement provenance. A row the read has not answered
 * for shows, never guesses.
 */
export const isSidebarMember = (
  thread: { readonly pinnedAt?: string | null | undefined },
  spawnedByAgent: boolean,
) => !(spawnedByAgent && thread.pinnedAt == null);

/** What the read says about one visible row: the agents placed under it, and how it came to be. */
export interface SpawnedChildrenRow {
  readonly children: ReadonlyArray<SpawnedChild>;
  /** An agent spawned this thread, so it shows under its spawner (register D22). */
  readonly spawnedByAgent: boolean;
}
export type SpawnedChildrenRowEntry = SpawnedChildrenRow & { readonly threadId: ThreadId };

/** One entry per requested row the read has something to say about. */
export const spawnedChildrenRows = (response: {
  readonly entries: ReadonlyArray<SpawnedChildrenEntry>;
  readonly spawnedByAgent: ReadonlyArray<ThreadId>;
}): ReadonlyArray<SpawnedChildrenRowEntry> => {
  const children = new Map(response.entries.map((entry) => [entry.threadId, entry.children]));
  const spawned = new Set(response.spawnedByAgent);
  return [...new Set([...children.keys(), ...spawned])].map((threadId) => ({
    threadId,
    children: children.get(threadId) ?? [],
    spawnedByAgent: spawned.has(threadId),
  }));
};

/** The visible rows are the whole truth for their children; parents that lost all children lose their entry. */
export const replaceSpawnedChildren = (
  previous: ReadonlyMap<string, SpawnedChildrenRow>,
  environmentId: EnvironmentId,
  requested: ReadonlyArray<ThreadId>,
  entries: ReadonlyArray<SpawnedChildrenRowEntry>,
) => {
  const next = new Map(previous);
  for (const threadId of requested)
    next.delete(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  for (const { threadId, ...row } of entries)
    next.set(scopedThreadKey(scopeThreadRef(environmentId, threadId)), row);
  return next;
};

export interface SpawnedChildThread extends CrewSeatThread {
  readonly id: string;
}

export interface SpawnedChildRow<T extends SpawnedChildThread> {
  readonly child: SpawnedChild;
  /** Undefined for a Crew seat whose thread the client holds no facts for: its state is unknown. */
  readonly thread: T | undefined;
}

const activityOf = <T extends SpawnedChildThread>(row: SpawnedChildRow<T>) =>
  row.thread?.updatedAt ?? "";

/**
 * Live children, most recent first. A Crew seat the client holds no thread for stays as a row
 * with no facts, so its Crew never under-counts or vanishes; it sorts last and reads as unknown.
 * A solo peer with no thread in client state waits until it arrives.
 */
export function selectSpawnedChildRows<T extends SpawnedChildThread>(
  children: ReadonlyArray<SpawnedChild>,
  threadsById: ReadonlyMap<string, T>,
): ReadonlyArray<SpawnedChildRow<T>> {
  return children
    .flatMap((child): Array<SpawnedChildRow<T>> => {
      const thread = threadsById.get(child.threadId);
      if (thread === undefined) return child.seat === null ? [] : [{ child, thread }];
      return thread.archivedAt !== null
        ? []
        : [{ child, thread: { ...thread, notStarted: child.seat?.notStarted ?? false } }];
    })
    .sort((left, right) => activityOf(right).localeCompare(activityOf(left)));
}

/** The collapsed header's discovery cue: a measured "needs a human" fact on any child. */
export const spawnedChildrenNeedAttention = <T extends SpawnedChildThread>(
  rows: ReadonlyArray<SpawnedChildRow<T>>,
) =>
  rows.some(
    ({ thread }) =>
      thread !== undefined && (thread.hasPendingApprovals || thread.hasPendingUserInput),
  );

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
    .sort(([, left], [, right]) => activityOf(right[0]!).localeCompare(activityOf(left[0]!)))
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

/**
 * Expansion is remembered per group under its parent, so the Crew you watch stays open on
 * reload; the environment is part of the key because the same local thread id on two
 * environments is two different rows.
 */
export const spawnedGroupExpansionKey = (
  environmentId: string,
  parentThreadId: string,
  groupKey: string,
) => `${environmentId}/${parentThreadId}/${groupKey}`;

/**
 * The Crew a Stop control on a group's header would stop: the group is a Crew and at least one
 * seat has a turn to interrupt. The solo-peer group and an idle Crew offer nothing.
 */
export const stoppableCrew = <T extends SpawnedChildThread>(
  group: SpawnedChildGroup<T>,
): { readonly crewInstanceId: string; readonly crewName: string } | null =>
  group.crew !== null &&
  crewHasRunningSeat(summarizeCrewState(group.rows.map(({ thread }) => thread)))
    ? group.crew
    : null;

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The collapsed count on the spawner's own row: "3 seats", "2 agents", "2 seats · 1 agent". */
export const spawnedChildrenCountLabel = <T extends SpawnedChildThread>(
  groups: ReadonlyArray<SpawnedChildGroup<T>>,
) => {
  let seats = 0;
  let agents = 0;
  for (const group of groups)
    if (group.crew === null) agents += group.rows.length;
    else seats += group.rows.length;
  return [seats > 0 ? counted(seats, "seat") : null, agents > 0 ? counted(agents, "agent") : null]
    .filter((part) => part !== null)
    .join(" · ");
};

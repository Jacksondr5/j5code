import { describe, expect, it } from "vite-plus/test";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { SpawnedChild } from "./SpawnedChildrenClient";
import { replaceSpawnedChildren } from "./SpawnedChildrenClient";
import {
  groupSpawnedChildren,
  readExpandedSpawnParents,
  selectSpawnedChildRows,
  spawnedChildrenNeedAttention,
  spawnedGroupExpansionKey,
  stoppableCrew,
  writeExpandedSpawnParents,
} from "./spawnedChildren.logic";

const child = (
  id: string,
  seat: string | null,
  crew: { crewInstanceId: string; crewName: string } = {
    crewInstanceId: "crew:1",
    crewName: "Review Pair",
  },
): SpawnedChild => ({
  threadId: ThreadId.make(id),
  participantId: `agent:j5:a2a:${id}`,
  seat: seat === null ? null : { ...crew, seat },
});
const thread = (
  id: string,
  updatedAt: string,
  overrides: Partial<{
    archivedAt: string | null;
    hasPendingApprovals: boolean;
    hasPendingUserInput: boolean;
    runtime: { status: "running" } | null;
  }> = {},
) => ({
  id,
  updatedAt,
  archivedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...overrides,
});

describe("spawned children under a sidebar row", () => {
  const threads = new Map([
    ["builder", thread("builder", "2026-09-09T10:00:00Z", { hasPendingUserInput: true })],
    ["critic", thread("critic", "2026-09-09T11:00:00Z")],
    ["retired", thread("retired", "2026-09-09T12:00:00Z", { archivedAt: "2026-09-09T12:30:00Z" })],
  ]);

  it("keeps live children with known threads, newest first", () => {
    const rows = selectSpawnedChildRows(
      [
        child("builder", "builder"),
        child("critic", "critic"),
        child("retired", "sitter"),
        child("pending", null),
      ],
      threads,
    );
    expect(rows.map(({ child }) => child.threadId)).toEqual(["critic", "builder"]);
    expect(spawnedChildrenNeedAttention(rows)).toBe(true);
  });

  it("groups seats by Crew, newest Crew first, with the solo peers as one more group", () => {
    const blog = { crewInstanceId: "crew:2", crewName: "Blog Migration" };
    const all = new Map([
      ...threads,
      ["writer", thread("writer", "2026-09-09T13:00:00Z", { runtime: { status: "running" } })],
      ["solo", thread("solo", "2026-09-09T09:00:00Z")],
    ]);
    const groups = groupSpawnedChildren(
      selectSpawnedChildRows(
        [
          child("builder", "builder"),
          child("critic", "critic"),
          child("writer", "writer", blog),
          child("solo", null),
        ],
        all,
      ),
    );
    expect(groups.map((group) => [group.key, group.crew?.crewName ?? null, group.summary])).toEqual(
      [
        ["crew:crew:2", "Blog Migration", "1 seat · 1 running"],
        // A seat waiting on a person is said on the Crew's header; idle seats stay unsaid.
        ["crew:crew:1", "Review Pair", "2 seats · 1 needs you"],
        ["agents", null, "1 agent"],
      ],
    );
    expect(groups.map((group) => group.needsAttention)).toEqual([false, true, false]);
    expect(groups[1]!.rows.map(({ child }) => child.threadId)).toEqual(["critic", "builder"]);
    expect(groupSpawnedChildren([])).toEqual([]);
    expect(spawnedGroupExpansionKey("env:a", "captain", "crew:crew:1")).toBe(
      "env:a/captain/crew:crew:1",
    );
    expect(spawnedGroupExpansionKey("env:b", "captain", "crew:crew:1")).not.toBe(
      spawnedGroupExpansionKey("env:a", "captain", "crew:crew:1"),
    );
  });

  it("offers Stop on a Crew's own group only while one of its seats is running", () => {
    const blog = { crewInstanceId: "crew:2", crewName: "Blog Migration" };
    const running = new Map([
      ["builder", thread("builder", "2026-09-09T10:00:00Z", { runtime: { status: "running" } })],
      ["critic", thread("critic", "2026-09-09T11:00:00Z")],
      ["writer", thread("writer", "2026-09-09T12:00:00Z")],
      ["solo", thread("solo", "2026-09-09T13:00:00Z", { runtime: { status: "running" } })],
    ]);
    const groups = groupSpawnedChildren(
      selectSpawnedChildRows(
        [
          child("builder", "builder"),
          child("critic", "critic"),
          child("writer", "writer", blog),
          child("solo", null),
        ],
        running,
      ),
    );
    // Blog Migration is idle, Review Pair has a running seat, and the solo group never stops.
    expect(groups.map((group) => stoppableCrew(group))).toEqual([
      null,
      { crewInstanceId: "crew:1", crewName: "Review Pair" },
      null,
    ]);
  });

  it("remembers expansion per parent and tolerates broken or missing storage", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    };
    writeExpandedSpawnParents(storage, new Set(["captain"]));
    expect([...readExpandedSpawnParents(storage)]).toEqual(["captain"]);
    backing.set("j5:sidebar:spawned-children:expanded", "{not json");
    expect(readExpandedSpawnParents(storage).size).toBe(0);
    expect(readExpandedSpawnParents(undefined).size).toBe(0);
  });

  it("treats the visible rows as the whole truth for their children", () => {
    const environmentId = EnvironmentId.make("env:a");
    const key = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
    const previous = new Map([
      [key("captain"), [child("builder", "builder")]],
      [key("other"), [child("x", null)]],
    ]);
    const next = replaceSpawnedChildren(
      previous,
      environmentId,
      [ThreadId.make("captain"), ThreadId.make("solo")],
      [{ threadId: ThreadId.make("solo"), children: [child("y", null)] }],
    );
    expect([...next.keys()].toSorted()).toEqual([key("other"), key("solo")].toSorted());
  });

  it("keeps a Crew seat with no thread as unknown, and measures it once its thread arrives", () => {
    const known = new Map([
      ["builder", thread("builder", "2026-09-09T10:00:00Z", { runtime: { status: "running" } })],
    ]);
    const seats = [child("builder", "builder"), child("critic", "critic")];
    const [review] = groupSpawnedChildren(selectSpawnedChildRows(seats, known));
    expect(review!.summary).toBe("2 seats · 1 running · 1 unknown");
    // The seat with no facts sorts last and carries none.
    expect(review!.rows.map(({ child, thread }) => [child.threadId, thread?.id ?? null])).toEqual([
      ["builder", "builder"],
      ["critic", null],
    ]);
    const [later] = groupSpawnedChildren(
      selectSpawnedChildRows(
        seats,
        new Map([...known, ["critic", thread("critic", "2026-09-09T11:00:00Z")]]),
      ),
    );
    expect(later!.summary).toBe("2 seats · 1 running");
  });

  it("names a Crew with no loaded seat at all instead of dropping it", () => {
    const groups = groupSpawnedChildren(
      selectSpawnedChildRows([child("builder", "builder"), child("critic", "critic")], new Map()),
    );
    expect(groups.map((group) => [group.crew?.crewName ?? null, group.summary])).toEqual([
      ["Review Pair", "2 seats · 2 unknown"],
    ]);
    expect(stoppableCrew(groups[0]!)).toBeNull();
    expect(spawnedChildrenNeedAttention(groups[0]!.rows)).toBe(false);
  });
});

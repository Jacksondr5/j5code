import { describe, expect, it } from "vite-plus/test";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { SpawnedChild } from "./SpawnedChildrenClient";
import { replaceSpawnedChildren } from "./SpawnedChildrenClient";
import {
  readExpandedSpawnParents,
  selectSpawnedChildRows,
  spawnedChildrenNeedAttention,
  spawnedChildrenSummary,
  writeExpandedSpawnParents,
} from "./spawnedChildren.logic";

const child = (id: string, seat: string | null): SpawnedChild => ({
  threadId: ThreadId.make(id),
  participantId: `agent:j5:a2a:${id}`,
  seat: seat === null ? null : { crewInstanceId: "crew:1", crewName: "Review Pair", seat },
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

  it("keeps live children with known threads, newest first, and summarizes them", () => {
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
    // A seat waiting on a person is said on the Captain's row; idle seats stay unsaid.
    expect(spawnedChildrenSummary(rows)).toBe("2 crew · 1 needs you");
    expect(spawnedChildrenNeedAttention(rows)).toBe(true);
    expect(spawnedChildrenSummary([])).toBeNull();
    const mixed = selectSpawnedChildRows(
      [child("builder", "builder"), child("critic", null)],
      threads,
    );
    expect(spawnedChildrenSummary(mixed)).toBe("2 agents");
    expect(spawnedChildrenSummary(mixed.slice(0, 1))).toBe("1 agent");
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
});

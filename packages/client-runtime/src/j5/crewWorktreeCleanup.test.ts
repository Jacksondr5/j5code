import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { CrewWorktreeCleanupEntry } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import {
  ANSWERED_ALREADY,
  answerFailure,
  cleanupButtons,
  groupCleanupOutcomes,
  inboxSummary,
  orderCleanupRows,
  outcomeReason,
  outcomeSummary,
  pickedCleanupPaths,
  placeWorktreeCleanups,
  pullRequestLabel,
  sliceCleanupRows,
  toggleCleanupPath,
  type ScopedWorktreeCleanup,
  worktreeCleanupKey,
} from "./crewWorktreeCleanup.ts";

const entry = (
  name: string,
  overrides: Partial<CrewWorktreeCleanupEntry> = {},
): CrewWorktreeCleanupEntry => ({
  threadId: ThreadId.make(`thread:${name}`),
  threadTitle: name,
  path: `/wt/${name}`,
  branch: `j5/${name}`,
  uncommittedFiles: 0,
  commitsAhead: 0,
  pullRequestUrl: null,
  outcome: null,
  reason: null,
  detail: null,
  ...overrides,
});

describe("the worktree cleanup item's list", () => {
  it("puts uncommitted work first, then commits only, and keeps five rows before Show more", () => {
    const rows = orderCleanupRows([
      entry("review", { commitsAhead: 1 }),
      entry("tests", { uncommittedFiles: 7 }),
      entry("replay", { uncommittedFiles: 12, commitsAhead: 5 }),
      entry("docs", { commitsAhead: 3 }),
      entry("adapter", { uncommittedFiles: 4, commitsAhead: 2 }),
      entry("spike", { uncommittedFiles: 3, commitsAhead: 8 }),
      entry("proto", { uncommittedFiles: 2 }),
      entry("flaky", { commitsAhead: 1 }),
    ]);
    expect(rows.map((row) => row.threadTitle)).toEqual([
      "replay",
      "tests",
      "adapter",
      "spike",
      "proto",
      "docs",
      "review",
      "flaky",
    ]);
    const collapsed = sliceCleanupRows(rows, false);
    expect(collapsed.shown).toHaveLength(5);
    expect(collapsed.hidden).toBe(3);
    expect(sliceCleanupRows(rows, true)).toEqual({ shown: rows, hidden: 0 });
    expect(sliceCleanupRows(rows.slice(0, 5), false).hidden).toBe(0);
  });
});

describe("picking worktrees to remove", () => {
  const entries = [entry("a"), entry("b"), entry("c")];

  it("starts with nothing picked: Remove is disabled at 0 and Select all is not", () => {
    expect(cleanupButtons(new Set(), entries)).toEqual({
      removeLabel: "Remove selected (0)",
      removeDisabled: true,
      selectAllDisabled: false,
    });
  });

  it("counts the picks, and disables Select all once every row is picked", () => {
    const picked = toggleCleanupPath(toggleCleanupPath(new Set(), "/wt/a"), "/wt/c");
    expect(cleanupButtons(picked, entries)).toMatchObject({
      removeLabel: "Remove selected (2)",
      removeDisabled: false,
      selectAllDisabled: false,
    });
    const all = new Set(entries.map((row) => row.path));
    expect(cleanupButtons(all, entries)).toMatchObject({
      removeLabel: "Remove selected (3)",
      selectAllDisabled: true,
    });
    expect(toggleCleanupPath(picked, "/wt/a").has("/wt/a")).toBe(false);
  });

  it("sends only picks the item still lists, in its order", () => {
    const picked = new Set(["/wt/c", "/wt/gone", "/wt/a"]);
    expect(pickedCleanupPaths(picked, entries)).toEqual(["/wt/a", "/wt/c"]);
    expect(cleanupButtons(picked, entries).removeLabel).toBe("Remove selected (2)");
  });
});

describe("where each cleanup shows", () => {
  const item = (id: string, status: "open" | "decided"): ScopedWorktreeCleanup => ({
    id,
    crewInstanceId: `crew:${id}`,
    crewName: id,
    projectId: "project",
    captainThreadId: ThreadId.make(`captain:${id}`),
    filedAt: "2026-11-14T10:00:00.000Z",
    status,
    decidedAt: status === "open" ? null : "2026-11-14T11:00:00.000Z",
    entries: [entry(id, status === "open" ? {} : { outcome: "removed" })],
    environmentId: EnvironmentId.make("env"),
    environmentLabel: "Laptop",
    connected: true,
    sourceReady: true,
  });
  const ids = (items: ReadonlyArray<ScopedWorktreeCleanup>) =>
    items.map((shown) => `${shown.id}:${shown.status}`);

  it("keeps an item answered here in place, as answered and then as read, and shelves the rest", () => {
    const [mine, theirs, older] = [
      item("mine", "open"),
      item("theirs", "open"),
      item("older", "decided"),
    ];
    const answered = { ...mine, status: "decided" as const };

    // Before any answer: the open ones in place, the decided one on the shelf.
    expect(
      ids(
        placeWorktreeCleanups({ open: [mine, theirs], decided: [older], answeredHere: new Map() })
          .inPlace,
      ),
    ).toEqual(["mine:open", "theirs:open"]);

    // Answered here: its answer stands in place until the reads catch up.
    const here = new Map([[worktreeCleanupKey(mine), answered]]);
    expect(
      ids(
        placeWorktreeCleanups({ open: [mine, theirs], decided: [older], answeredHere: here })
          .inPlace,
      ),
    ).toEqual(["mine:decided", "theirs:open"]);

    // After the reads: the decided read's copy stays in place, after the open ones, not on the shelf.
    const read = { ...answered, decidedAt: "2026-11-14T12:00:00.000Z" };
    const placed = placeWorktreeCleanups({
      open: [theirs],
      decided: [read, older],
      answeredHere: here,
    });
    expect(placed.inPlace).toEqual([theirs, read]);
    expect(ids(placed.shelf)).toEqual(["older:decided"]);
  });

  it("holds a refused answer back until the decided read shows how it was answered", () => {
    const mine = item("mine", "open");
    const refused = new Map([[worktreeCleanupKey(mine), null]]);
    expect(placeWorktreeCleanups({ open: [], decided: [], answeredHere: refused }).inPlace).toEqual(
      [],
    );
    const elsewhere = item("mine", "decided");
    expect(
      placeWorktreeCleanups({ open: [], decided: [elsewhere], answeredHere: refused }),
    ).toEqual({
      inPlace: [elsewhere],
      shelf: [],
    });
  });
});

describe("the decided item", () => {
  const decided = [
    entry("done", { outcome: "removed" }),
    entry("later", { outcome: "kept" }),
    entry("busy", { outcome: "skipped", reason: "in_use" }),
    entry("changed", { outcome: "skipped", reason: "changed" }),
    entry("locked", { outcome: "failed", detail: "git worktree remove failed" }),
  ];

  it("groups by outcome in the order removed, kept, skipped, failed", () => {
    expect(
      groupCleanupOutcomes(decided).map((group) => [
        group.label,
        group.rows.map((row) => row.threadTitle),
      ]),
    ).toEqual([
      ["Removed", ["done"]],
      ["Kept", ["later"]],
      ["Skipped", ["busy", "changed"]],
      ["Failed", ["locked"]],
    ]);
    expect(groupCleanupOutcomes(decided.slice(0, 1)).map((group) => group.label)).toEqual([
      "Removed",
    ]);
    expect(outcomeSummary(decided)).toBe("1 removed · 1 kept · 2 skipped · 1 failed");
  });

  it("gives each row its reason: not picked, why it was skipped, git's own text", () => {
    expect(decided.map(outcomeReason)).toEqual([
      null,
      "Not picked",
      "A session is open in it",
      "Changed since this was filed",
      "git worktree remove failed",
    ]);
  });
});

describe("a refused answer", () => {
  it("says it was already answered in the server's words, and shows the decided item", () => {
    const refusal = Object.assign(new Error("This worktree cleanup was already answered."), {
      code: "CrewWorktreeCleanupAnsweredError",
    });
    expect(answerFailure(refusal)).toEqual({ message: ANSWERED_ALREADY, alreadyAnswered: true });
    expect(ANSWERED_ALREADY).toBe("This worktree cleanup was already answered.");
  });

  it("keeps any other failure open with its own message", () => {
    expect(
      answerFailure(
        Object.assign(new Error("Owners only."), { code: "EnvironmentAuthorizationError" }),
      ),
    ).toEqual({ message: "Owners only.", alreadyAnswered: false });
    expect(answerFailure("boom")).toEqual({
      message: "Could not answer the worktree cleanup.",
      alreadyAnswered: false,
    });
  });
});

it("names a pull request by its number when the link has one", () => {
  expect(pullRequestLabel("https://github.com/Jacksondr5/j5code/pull/815")).toBe("PR #815");
  expect(pullRequestLabel("https://example.test/mr/7")).toBe("Pull request");
});

describe("inboxSummary", () => {
  it("counts worktree cleanups apart from questions", () => {
    expect(
      inboxSummary({ questions: 2, complete: true, agentRequests: 0, worktreeCleanups: 0 }),
    ).toBe("2 questions open");
    expect(
      inboxSummary({ questions: 1, complete: false, agentRequests: 3, worktreeCleanups: 1 }),
    ).toBe("1 question loaded · 3 agent requests · 1 worktree cleanup");
    expect(
      inboxSummary({ questions: 0, complete: true, agentRequests: 1, worktreeCleanups: 2 }),
    ).toBe("0 questions open · 1 agent request · 2 worktree cleanups");
  });
});

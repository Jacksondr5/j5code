import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ScopedManagedSquadron } from "../squadron/SquadronDirectory";
import {
  addOnboardingRow,
  defaultOnboardingRowId,
  describeOnboardingFolderOutcome,
  eligibleExistingSquadrons,
  ensureOnboardingFolderSquadrons,
  ensureOnboardingSquadron,
  hasKeptConversations,
  isOnboardingFolderComplete,
  openOnboardingSquadronDraft,
  removeOnboardingRow,
  resolveOnboardingLandingSquadron,
  resolveOnboardingRows,
  resolveOnboardingSquadronsReadiness,
  selectImportRecipientRow,
  summarizeAssignmentEntries,
  updateOnboardingRow,
  type OnboardingSquadronHome,
  type OnboardingSquadronRow,
} from "./onboardingSquadrons.logic";

const laptop = EnvironmentId.make("env:laptop");
const buildBox = EnvironmentId.make("env:build-box");
const apiProject = ProjectId.make("project:api");
const webProject = ProjectId.make("project:web");

const squadron = (
  id: string,
  environmentId: EnvironmentId,
  projectIds: ReadonlyArray<ProjectId>,
): ScopedManagedSquadron => ({
  squadron: { id, name: id.replace("squadron:", ""), createdAt: "2026-09-17T00:00:00Z" },
  projectIds,
  environmentId,
  environmentLabel: environmentId,
  available: true,
});

class RejectedError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
const isDefiniteRejection = (error: unknown) =>
  error instanceof RejectedError && error.status >= 400 && error.status < 500;

describe("Squadron rows", () => {
  const folder = { key: "k", title: "acme-api" };

  it("defaults each folder to one row with a stable id, named after the folder", () => {
    const first = resolveOnboardingRows(new Map(), folder);
    const second = resolveOnboardingRows(new Map(), folder);
    expect(first).toEqual([
      { rowId: defaultOnboardingRowId("k"), assignment: { kind: "new", name: "acme-api" } },
    ]);
    expect(second[0]?.rowId).toBe(first[0]?.rowId);
  });

  it("keeps a folder's rows so deselecting and reselecting restores every choice", () => {
    const stored: ReadonlyArray<OnboardingSquadronRow> = [
      { rowId: "row-1", assignment: { kind: "existing", squadronId: "squadron:alpha" } },
      { rowId: "row-2", assignment: { kind: "new", name: "Bravo" } },
    ];
    expect(resolveOnboardingRows(new Map([["k", stored]]), folder)).toBe(stored);
  });

  it("adds unnamed rows, edits by id, and the first row is the import recipient", () => {
    const rows = addOnboardingRow(resolveOnboardingRows(new Map(), folder), "row-2");
    const renamed = updateOnboardingRow(rows, "row-2", { kind: "new", name: "Bravo" });
    expect(rows[1]).toEqual({ rowId: "row-2", assignment: { kind: "new", name: "" } });
    expect(renamed.map((row) => row.assignment)).toEqual([
      { kind: "new", name: "acme-api" },
      { kind: "new", name: "Bravo" },
    ]);
    expect(selectImportRecipientRow(renamed)?.rowId).toBe(defaultOnboardingRowId("k"));
  });

  it("never removes the last row, a created row, or an unconfirmed row", () => {
    const only = resolveOnboardingRows(new Map(), folder);
    const rows = addOnboardingRow(only, "row-2");
    const homes = new Map<string, OnboardingSquadronHome>([
      [
        "row-2",
        {
          squadronId: "squadron:bravo",
          name: "Bravo",
          projectRef: { environmentId: laptop, projectId: apiProject },
        },
      ],
    ]);
    const unconfirmed = updateOnboardingRow(rows, "row-2", { kind: "unconfirmed", name: "x" });
    expect(removeOnboardingRow(only, only[0]!.rowId, new Map())).toBe(only);
    expect(removeOnboardingRow(rows, "row-2", homes)).toBe(rows);
    expect(removeOnboardingRow(unconfirmed, "row-2", new Map())).toBe(unconfirmed);
    expect(removeOnboardingRow(rows, only[0]!.rowId, homes).map((row) => row.rowId)).toEqual([
      "row-2",
    ]);
  });
});

describe("eligibleExistingSquadrons", () => {
  const directory = [
    squadron("squadron:alpha", laptop, [apiProject]),
    squadron("squadron:web", laptop, [webProject]),
    squadron("squadron:remote-api", buildBox, [apiProject]),
    squadron("squadron:multi", laptop, [apiProject, webProject]),
  ];

  it("offers only Squadrons on the folder's own computer that reference exactly its project", () => {
    expect(
      eligibleExistingSquadrons(directory, { environmentId: laptop, projectId: apiProject }).map(
        (entry) => entry.squadron.id,
      ),
    ).toEqual(["squadron:alpha"]);
  });

  it("offers nothing for a folder that is not a registered project yet", () => {
    expect(
      eligibleExistingSquadrons(directory, { environmentId: laptop, projectId: null }),
    ).toEqual([]);
  });
});

describe("resolveOnboardingSquadronsReadiness", () => {
  const folders = [
    { key: "a", title: "acme-api" },
    { key: "b", title: "acme-web" },
  ];

  const rowsOf = (entries: Record<string, ReadonlyArray<OnboardingSquadronRow>>) =>
    new Map(Object.entries(entries));

  it("blocks the import while any row has an unconfirmed create", () => {
    const rows = rowsOf({
      a: [
        { rowId: "a-1", assignment: { kind: "new", name: "acme-api" } },
        { rowId: "a-2", assignment: { kind: "unconfirmed", name: "Bravo" } },
      ],
      b: [{ rowId: "b-1", assignment: { kind: "new", name: " " } }],
    });
    expect(resolveOnboardingSquadronsReadiness(folders, rows, new Map())).toBe("unconfirmed");
  });

  it("blocks the import while any new Squadron on any row has no name", () => {
    const rows = rowsOf({
      b: [
        { rowId: "b-1", assignment: { kind: "new", name: "acme-web" } },
        { rowId: "b-2", assignment: { kind: "new", name: "  " } },
      ],
    });
    expect(resolveOnboardingSquadronsReadiness(folders, rows, new Map())).toBe("empty-name");
  });

  it("ignores rows whose Squadron already landed", () => {
    const rows = rowsOf({ a: [{ rowId: "a-1", assignment: { kind: "unconfirmed", name: "x" } }] });
    const homes = new Map<string, OnboardingSquadronHome>([
      [
        "a-1",
        {
          squadronId: "squadron:alpha",
          name: "alpha",
          projectRef: { environmentId: laptop, projectId: apiProject },
        },
      ],
    ]);
    expect(resolveOnboardingSquadronsReadiness(folders, rows, homes)).toBe("ready");
  });
});

describe("ensureOnboardingSquadron", () => {
  const projectRef = { environmentId: laptop, projectId: apiProject };

  it("creates a new Squadron once and remembers it for retries", async () => {
    const createSquadron = vi.fn(
      async (_environmentId: EnvironmentId, input: { name: string }) => ({
        squadron: { id: "squadron:created", name: input.name },
      }),
    );
    const homes = new Map<string, OnboardingSquadronHome>();
    const input = {
      key: "a",
      projectRef,
      assignment: { kind: "new", name: " acme-api " } as const,
      homes,
      existingSquadrons: [],
      createSquadron,
      isDefiniteRejection,
    };

    const first = await ensureOnboardingSquadron(input);
    const second = await ensureOnboardingSquadron(input);

    expect(first).toEqual({
      kind: "ready",
      home: { squadronId: "squadron:created", name: "acme-api", projectRef },
    });
    expect(second).toEqual(first);
    expect(createSquadron).toHaveBeenCalledTimes(1);
    expect(createSquadron).toHaveBeenCalledWith(laptop, {
      name: "acme-api",
      projectId: apiProject,
    });
  });

  it("reports a lost create as unconfirmed and never creates again on its own", async () => {
    const createSquadron = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const homes = new Map<string, OnboardingSquadronHome>();
    const lost = await ensureOnboardingSquadron({
      key: "a",
      projectRef,
      assignment: { kind: "new", name: "acme-api" },
      homes,
      existingSquadrons: [],
      createSquadron,
      isDefiniteRejection,
    });
    const retried = await ensureOnboardingSquadron({
      key: "a",
      projectRef,
      assignment: { kind: "unconfirmed", name: "acme-api" },
      homes,
      existingSquadrons: [squadron("squadron:acme-api", laptop, [apiProject])],
      createSquadron,
      isDefiniteRejection,
    });

    expect(lost).toEqual({ kind: "unconfirmed" });
    expect(retried).toEqual({ kind: "unconfirmed" });
    expect(createSquadron).toHaveBeenCalledTimes(1);
    expect(homes.size).toBe(0);
  });

  it("treats a definite rejection as a plain failure that may be retried", async () => {
    const createSquadron = vi.fn(async () => {
      throw new RejectedError(400);
    });
    const result = await ensureOnboardingSquadron({
      key: "a",
      projectRef,
      assignment: { kind: "new", name: "acme-api" },
      homes: new Map(),
      existingSquadrons: [],
      createSquadron,
      isDefiniteRejection,
    });
    expect(result).toEqual({ kind: "failed", message: "HTTP 400" });
  });

  it("uses an explicitly chosen existing Squadron only when it still references this folder", async () => {
    const createSquadron = vi.fn();
    const homes = new Map<string, OnboardingSquadronHome>();
    const chosen = await ensureOnboardingSquadron({
      key: "a",
      projectRef,
      assignment: { kind: "existing", squadronId: "squadron:alpha" },
      homes,
      existingSquadrons: [squadron("squadron:alpha", laptop, [apiProject])],
      createSquadron,
      isDefiniteRejection,
    });
    const stale = await ensureOnboardingSquadron({
      key: "b",
      projectRef: { environmentId: laptop, projectId: webProject },
      assignment: { kind: "existing", squadronId: "squadron:alpha" },
      homes,
      existingSquadrons: [squadron("squadron:alpha", laptop, [apiProject])],
      createSquadron,
      isDefiniteRejection,
    });

    expect(chosen).toEqual({
      kind: "ready",
      home: { squadronId: "squadron:alpha", name: "alpha", projectRef },
    });
    expect(stale).toMatchObject({ kind: "failed" });
    expect(createSquadron).not.toHaveBeenCalled();
  });
});

describe("ensureOnboardingFolderSquadrons", () => {
  const projectRef = { environmentId: laptop, projectId: apiProject };

  it("retries only the rows that did not land", async () => {
    let failBravo = true;
    const createSquadron = vi.fn(async (_environmentId: EnvironmentId, input: { name: string }) => {
      if (input.name === "Bravo" && failBravo) throw new RejectedError(400);
      return { squadron: { id: `squadron:${input.name.toLowerCase()}`, name: input.name } };
    });
    const homes = new Map<string, OnboardingSquadronHome>();
    const rows: ReadonlyArray<OnboardingSquadronRow> = [
      { rowId: "row-alpha", assignment: { kind: "new", name: "Alpha" } },
      { rowId: "row-bravo", assignment: { kind: "new", name: "Bravo" } },
    ];
    const base = { projectRef, homes, existingSquadrons: [], createSquadron, isDefiniteRejection };

    const first = await ensureOnboardingFolderSquadrons({ rows, ...base });
    failBravo = false;
    const retry = await ensureOnboardingFolderSquadrons({
      rows: addOnboardingRow(rows, "row-charlie").map((row) =>
        row.rowId === "row-charlie"
          ? { ...row, assignment: { kind: "new", name: "Charlie" } }
          : row,
      ),
      ...base,
    });

    expect(first.recipient?.squadronId).toBe("squadron:alpha");
    expect(first.failures).toEqual([
      { rowId: "row-bravo", result: { kind: "failed", message: "HTTP 400" } },
    ]);
    expect(retry.recipient?.squadronId).toBe("squadron:alpha");
    expect(retry.failures).toEqual([]);
    expect(createSquadron.mock.calls.map(([, input]) => input.name)).toEqual([
      "Alpha",
      "Bravo",
      "Bravo",
      "Charlie",
    ]);
    expect([...homes.keys()]).toEqual(["row-alpha", "row-bravo", "row-charlie"]);
  });

  it("lands on the first row's Squadron even when an extra row was created earlier", async () => {
    let failAlpha = true;
    const createSquadron = vi.fn(async (_environmentId: EnvironmentId, input: { name: string }) => {
      if (input.name === "Alpha" && failAlpha) throw new Error("socket hang up");
      return { squadron: { id: `squadron:${input.name.toLowerCase()}`, name: input.name } };
    });
    const homes = new Map<string, OnboardingSquadronHome>();
    // The wizard records a folder's recipient only when its first row landed.
    const recipients = new Map<string, OnboardingSquadronHome>();
    const rows: ReadonlyArray<OnboardingSquadronRow> = [
      { rowId: "row-alpha", assignment: { kind: "new", name: "Alpha" } },
      { rowId: "row-bravo", assignment: { kind: "new", name: "Bravo" } },
    ];
    const base = { projectRef, homes, existingSquadrons: [], createSquadron, isDefiniteRejection };

    const first = await ensureOnboardingFolderSquadrons({ rows, ...base });
    if (first.recipient !== null) recipients.set("folder", first.recipient);
    failAlpha = false;
    const retry = await ensureOnboardingFolderSquadrons({
      rows: updateOnboardingRow(rows, "row-alpha", { kind: "new", name: "Alpha" }),
      ...base,
    });
    if (retry.recipient !== null) recipients.set("folder", retry.recipient);

    expect(first.recipient).toBeNull();
    expect([...homes.keys()]).toEqual(["row-bravo", "row-alpha"]);
    expect(resolveOnboardingLandingSquadron(projectRef, recipients)).toEqual({
      environmentId: laptop,
      squadronId: "squadron:alpha",
    });
    expect(createSquadron.mock.calls.map(([, input]) => input.name)).toEqual([
      "Alpha",
      "Bravo",
      "Alpha",
    ]);
  });

  it("reports no recipient when the first row is the one that failed", async () => {
    const createSquadron = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const result = await ensureOnboardingFolderSquadrons({
      rows: [{ rowId: "row-alpha", assignment: { kind: "new", name: "Alpha" } }],
      projectRef,
      homes: new Map(),
      existingSquadrons: [],
      createSquadron,
      isDefiniteRejection,
    });
    expect(result).toEqual({
      recipient: null,
      failures: [{ rowId: "row-alpha", result: { kind: "unconfirmed" } }],
    });
  });
});

describe("folder outcomes", () => {
  const entries = (
    ...statuses: ReadonlyArray<
      | "assigned"
      | "already_assigned"
      | "kept_elsewhere"
      | "kept_retired"
      | "kept_archived"
      | "failed"
    >
  ) => statuses.map((status, index) => ({ threadId: ThreadId.make(`thread-${index}`), status }));

  it("counts every assignment status and reports kept conversations without moving them", () => {
    const summary = summarizeAssignmentEntries(
      entries("assigned", "assigned", "kept_elsewhere", "kept_retired", "already_assigned"),
    );
    const outcome = {
      kind: "done",
      squadronName: "Alpha",
      importedCount: 2,
      skippedCount: 0,
      assignment: summary,
    } as const;

    expect(summary).toEqual({
      assigned: 2,
      already_assigned: 1,
      kept_elsewhere: 1,
      kept_retired: 1,
      kept_archived: 0,
      failed: 0,
    });
    expect(isOnboardingFolderComplete(outcome)).toBe(true);
    expect(hasKeptConversations(summary)).toBe(true);
    expect(
      hasKeptConversations(summarizeAssignmentEntries(entries("assigned", "already_assigned"))),
    ).toBe(false);
    expect(describeOnboardingFolderOutcome(outcome).headline).toBe(
      "Alpha: 2 conversations added · 1 already here · 1 kept in another Squadron · 1 kept (retired).",
    );
  });

  it("keeps a folder retryable when any conversation failed to assign or import", () => {
    const failedAssign = {
      kind: "done",
      squadronName: "Alpha",
      importedCount: 3,
      skippedCount: 0,
      assignment: summarizeAssignmentEntries(entries("assigned", "failed")),
    } as const;
    const skipped = {
      ...failedAssign,
      assignment: summarizeAssignmentEntries([]),
      skippedCount: 1,
    };

    expect(isOnboardingFolderComplete(failedAssign)).toBe(false);
    expect(isOnboardingFolderComplete(skipped)).toBe(false);
    expect(describeOnboardingFolderOutcome({ kind: "squadron_unconfirmed" }).detail).toContain(
      "Existing",
    );
  });
});

describe("landing", () => {
  it("carries the landing folder's import recipient into the draft, and nothing when it has none", async () => {
    const projectRef = { environmentId: laptop, projectId: apiProject };
    const homes = new Map<string, OnboardingSquadronHome>([
      [
        "web",
        {
          squadronId: "squadron:web",
          name: "web",
          projectRef: { environmentId: laptop, projectId: webProject },
        },
      ],
      ["api", { squadronId: "squadron:alpha", name: "alpha", projectRef }],
    ]);
    const squadronRef = resolveOnboardingLandingSquadron(projectRef, homes);
    const selectDraftSquadron = vi.fn();
    const draft = { draftId: "draft-1", threadId: ThreadId.make("thread-1") };

    expect(squadronRef).toEqual({ environmentId: laptop, squadronId: "squadron:alpha" });
    await openOnboardingSquadronDraft({
      projectRef,
      squadron: squadronRef,
      handleNewThread: async () => draft,
      selectDraftSquadron,
    });
    await openOnboardingSquadronDraft({
      projectRef,
      squadron: undefined,
      handleNewThread: async () => draft,
      selectDraftSquadron,
    });

    expect(selectDraftSquadron).toHaveBeenCalledTimes(1);
    expect(selectDraftSquadron).toHaveBeenCalledWith(`${laptop}:thread-1`, "squadron:alpha");
    expect(
      resolveOnboardingLandingSquadron({ environmentId: buildBox, projectId: apiProject }, homes),
    ).toBeUndefined();
  });
});

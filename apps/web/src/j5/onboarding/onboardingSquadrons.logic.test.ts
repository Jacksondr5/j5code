import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ScopedManagedSquadron } from "../squadron/SquadronDirectory";
import {
  describeOnboardingFolderOutcome,
  eligibleExistingSquadrons,
  ensureOnboardingSquadron,
  hasKeptConversations,
  isOnboardingFolderComplete,
  openOnboardingSquadronDraft,
  resolveOnboardingAssignment,
  resolveOnboardingLandingSquadron,
  resolveOnboardingSquadronsReadiness,
  summarizeAssignmentEntries,
  type OnboardingSquadronAssignment,
  type OnboardingSquadronHome,
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

describe("resolveOnboardingAssignment", () => {
  it("defaults each folder to a new Squadron named after the folder", () => {
    expect(resolveOnboardingAssignment(new Map(), { key: "k", title: "acme-api" })).toEqual({
      kind: "new",
      name: "acme-api",
    });
  });

  it("keeps a folder's earlier choice so deselecting and reselecting restores it", () => {
    const assignments = new Map<string, OnboardingSquadronAssignment>([
      ["k", { kind: "existing", squadronId: "squadron:alpha" }],
    ]);
    expect(resolveOnboardingAssignment(assignments, { key: "k", title: "acme-api" })).toEqual({
      kind: "existing",
      squadronId: "squadron:alpha",
    });
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

  it("blocks the import while any selected folder has an unconfirmed create", () => {
    const assignments = new Map<string, OnboardingSquadronAssignment>([
      ["a", { kind: "unconfirmed", name: "acme-api" }],
      ["b", { kind: "new", name: " " }],
    ]);
    expect(resolveOnboardingSquadronsReadiness(folders, assignments, new Map())).toBe(
      "unconfirmed",
    );
  });

  it("blocks the import while a new Squadron has no name", () => {
    const assignments = new Map<string, OnboardingSquadronAssignment>([
      ["b", { kind: "new", name: "  " }],
    ]);
    expect(resolveOnboardingSquadronsReadiness(folders, assignments, new Map())).toBe("empty-name");
  });

  it("ignores folders whose Squadron already landed", () => {
    const assignments = new Map<string, OnboardingSquadronAssignment>([
      ["a", { kind: "unconfirmed", name: "acme-api" }],
    ]);
    const homes = new Map<string, OnboardingSquadronHome>([
      [
        "a",
        {
          squadronId: "squadron:alpha",
          name: "alpha",
          projectRef: { environmentId: laptop, projectId: apiProject },
        },
      ],
    ]);
    expect(resolveOnboardingSquadronsReadiness(folders, assignments, homes)).toBe("ready");
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
  it("carries the landing folder's own Squadron into the draft, and nothing when it has none", async () => {
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

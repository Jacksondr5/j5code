import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { filterThreadsForSquadronScope } from "./SquadronScope.logic";
import {
  buildSquadronPickerRow,
  buildSquadronPickerEntries,
  canCreateThreadWithoutSquadronPicker,
  resolveCurrentThreadNewThreadDestination,
  resolveIndexDraftDestination,
  resolveNewThreadShortcutDestination,
  squadronDraftScopeKey,
  startSquadronDraft,
} from "./SquadronPicker.logic";

const sharedFolder = {
  environmentId: EnvironmentId.make("environment:primary"),
  id: ProjectId.make("project:shared"),
  title: "Shared folder",
  workspaceRoot: "/work/shared",
} as const;

describe("Squadron picker", () => {
  it("renders a Squadron picker row without a folder-description second line", () => {
    const [entry] = buildSquadronPickerEntries({
      squadrons: [
        {
          squadron: { id: "squadron:alpha", name: "Alpha", createdAt: "2026-08-31T00:00:00Z" },
          projectIds: [sharedFolder.id],
        },
      ],
      projects: [sharedFolder],
      primaryEnvironmentId: sharedFolder.environmentId,
    });

    const row = buildSquadronPickerRow(entry!);
    expect(row).toEqual({
      searchTerms: ["Alpha", "Shared folder", "/work/shared"],
      title: "Alpha",
    });
    expect(row).not.toHaveProperty("description");
  });

  it("keys Squadron draft state by immutable returned thread id, never local draft id", () => {
    const draft = { draftId: "draft:sole", threadId: ThreadId.make("thread:sole") };

    expect(squadronDraftScopeKey(sharedFolder.environmentId, draft)).toBe(
      scopedThreadKey(scopeThreadRef(sharedFolder.environmentId, draft.threadId)),
    );
    expect(squadronDraftScopeKey(sharedFolder.environmentId, draft)).not.toBe(
      scopedThreadKey(scopeThreadRef(sharedFolder.environmentId, ThreadId.make(draft.draftId))),
    );
  });

  it("keys a branch draft with its source environment and returned thread id", () => {
    const branchEnvironmentId = EnvironmentId.make("environment:branch");
    const draft = { draftId: "draft:branch", threadId: ThreadId.make("thread:branch") };

    expect(squadronDraftScopeKey(branchEnvironmentId, draft)).toBe(
      scopedThreadKey(scopeThreadRef(branchEnvironmentId, draft.threadId)),
    );
    expect(squadronDraftScopeKey(branchEnvironmentId, draft)).not.toBe(
      scopedThreadKey(scopeThreadRef(branchEnvironmentId, ThreadId.make(draft.draftId))),
    );
  });

  it("requires the picker until exactly one Registrar Squadron is ready", () => {
    expect(canCreateThreadWithoutSquadronPicker("loading", 1)).toBe(false);
    expect(canCreateThreadWithoutSquadronPicker("ready", 0)).toBe(false);
    expect(canCreateThreadWithoutSquadronPicker("ready", 1)).toBe(true);
    expect(canCreateThreadWithoutSquadronPicker("ready", 2)).toBe(false);
  });

  it("routes keyboard creation through the picker for shared-folder Squadrons", () => {
    const entries = buildSquadronPickerEntries({
      squadrons: [
        {
          squadron: { id: "squadron:alpha", name: "Alpha", createdAt: "2026-08-31T00:00:00Z" },
          projectIds: [sharedFolder.id],
        },
        {
          squadron: { id: "squadron:bravo", name: "Bravo", createdAt: "2026-08-31T00:00:00Z" },
          projectIds: [sharedFolder.id],
        },
      ],
      projects: [sharedFolder],
      primaryEnvironmentId: sharedFolder.environmentId,
    });
    expect(resolveNewThreadShortcutDestination("ready", entries)).toEqual({ kind: "picker" });
    expect(resolveNewThreadShortcutDestination("ready", [entries[0]!])).toMatchObject({
      kind: "single-squadron",
      entry: { squadronId: "squadron:alpha" },
    });
  });

  it("keys the Sidebar and keyboard exact-one carrier by returned thread id", async () => {
    const [entry] = buildSquadronPickerEntries({
      squadrons: [
        {
          squadron: { id: "squadron:sole", name: "Sole", createdAt: "2026-08-31T00:00:00Z" },
          projectIds: [sharedFolder.id],
        },
      ],
      projects: [sharedFolder],
      primaryEnvironmentId: sharedFolder.environmentId,
    });
    const handleNewThread = vi.fn(async () => ({
      draftId: "draft:sole",
      threadId: ThreadId.make("thread:sole"),
    }));
    const selectDraftSquadron = vi.fn();
    await startSquadronDraft({ entry: entry!, handleNewThread, selectDraftSquadron });
    expect(handleNewThread).toHaveBeenCalledWith(sharedFolder);
    expect(selectDraftSquadron).toHaveBeenCalledWith(
      scopedThreadKey(scopeThreadRef(sharedFolder.environmentId, ThreadId.make("thread:sole"))),
      "squadron:sole",
    );
  });

  it("keys the current-thread carrier by Solo's returned thread, not an unscoped active folder", async () => {
    const activeFolder = {
      environmentId: sharedFolder.environmentId,
      id: ProjectId.make("project:active-unscoped"),
      title: "Active unscoped folder",
      workspaceRoot: "/work/active-unscoped",
    } as const;
    const [soleEntry] = buildSquadronPickerEntries({
      squadrons: [
        {
          squadron: { id: "squadron:solo", name: "Solo", createdAt: "2026-08-31T00:00:00Z" },
          projectIds: [sharedFolder.id],
        },
      ],
      projects: [sharedFolder, activeFolder],
      primaryEnvironmentId: sharedFolder.environmentId,
    });
    const destination = resolveCurrentThreadNewThreadDestination(null, "ready", [soleEntry!]);
    const handleNewThread = vi.fn(async () => ({
      draftId: "draft:solo",
      threadId: ThreadId.make("thread:solo"),
    }));
    const selectDraftSquadron = vi.fn();

    expect(destination).toMatchObject({
      kind: "single-squadron",
      entry: { squadronId: "squadron:solo" },
    });
    if (destination.kind === "single-squadron") {
      await startSquadronDraft({
        entry: destination.entry,
        handleNewThread,
        selectDraftSquadron,
      });
    }
    expect(handleNewThread).toHaveBeenCalledWith(sharedFolder);
    expect(handleNewThread).not.toHaveBeenCalledWith(activeFolder);
    expect(selectDraftSquadron).toHaveBeenCalledWith(
      scopedThreadKey(scopeThreadRef(sharedFolder.environmentId, ThreadId.make("thread:solo"))),
      "squadron:solo",
    );
  });

  it("keeps a known current-thread home even when another Squadron is the only shortcut candidate", () => {
    const entries = [
      { squadronId: "squadron:active", name: "Active", folder: sharedFolder },
      { squadronId: "squadron:other", name: "Other", folder: sharedFolder },
    ];

    expect(
      resolveCurrentThreadNewThreadDestination("squadron:active", "ready", entries),
    ).toMatchObject({ kind: "single-squadron", entry: { squadronId: "squadron:active" } });
  });

  it("routes the Sidebar branch door through the source Registrar home and carrier", async () => {
    const sourceFolder = {
      environmentId: sharedFolder.environmentId,
      id: ProjectId.make("project:branch-source"),
      title: "Unscoped branch source",
      workspaceRoot: "/work/branch-source",
    } as const;
    const homeEntry = {
      squadronId: "squadron:home",
      name: "Home",
      folder: sharedFolder,
    } as const;
    const destination = resolveCurrentThreadNewThreadDestination("squadron:home", "ready", [
      homeEntry,
      { squadronId: "squadron:other", name: "Other", folder: sourceFolder },
    ]);
    const handleNewThread = vi.fn(async () => ({
      draftId: "draft:branch-home",
      threadId: ThreadId.make("thread:branch-home"),
    }));
    const selectDraftSquadron = vi.fn();

    expect(destination).toEqual({ kind: "single-squadron", entry: homeEntry });
    if (destination.kind === "single-squadron") {
      await startSquadronDraft({
        entry: destination.entry,
        handleNewThread,
        selectDraftSquadron,
      });
    }

    expect(handleNewThread).toHaveBeenCalledWith(sharedFolder);
    expect(handleNewThread).not.toHaveBeenCalledWith(sourceFolder);
    expect(selectDraftSquadron).toHaveBeenCalledWith(
      scopedThreadKey(
        scopeThreadRef(sharedFolder.environmentId, ThreadId.make("thread:branch-home")),
      ),
      "squadron:home",
    );
  });

  it("only auto-starts the index route for a selected or sole Squadron", () => {
    const entries = [
      { squadronId: "squadron:alpha", name: "Alpha", folder: sharedFolder },
      { squadronId: "squadron:bravo", name: "Bravo", folder: sharedFolder },
    ];

    expect(resolveIndexDraftDestination("squadron:bravo", "ready", entries)).toMatchObject({
      kind: "single-squadron",
      entry: { squadronId: "squadron:bravo" },
    });
    expect(resolveIndexDraftDestination(null, "ready", [entries[0]!])).toMatchObject({
      kind: "single-squadron",
      entry: { squadronId: "squadron:alpha" },
    });
    expect(resolveIndexDraftDestination(null, "ready", entries)).toEqual({ kind: "index" });
    expect(resolveIndexDraftDestination(null, "ready", [])).toEqual({ kind: "index" });
  });

  it("keys the index carrier by Solo's returned thread, not its most-recent unscoped folder", async () => {
    const mostRecentFolder = {
      environmentId: sharedFolder.environmentId,
      id: ProjectId.make("project:most-recent-unscoped"),
      title: "Most recent unscoped folder",
      workspaceRoot: "/work/most-recent-unscoped",
    } as const;
    const [soleEntry] = buildSquadronPickerEntries({
      squadrons: [
        {
          squadron: { id: "squadron:solo", name: "Solo", createdAt: "2026-08-31T00:00:00Z" },
          projectIds: [sharedFolder.id],
        },
      ],
      projects: [sharedFolder, mostRecentFolder],
      primaryEnvironmentId: sharedFolder.environmentId,
    });
    const destination = resolveIndexDraftDestination(null, "ready", [soleEntry!]);
    const handleNewThread = vi.fn(async () => ({
      draftId: "draft:index-solo",
      threadId: ThreadId.make("thread:index-solo"),
    }));
    const selectDraftSquadron = vi.fn();

    expect(destination).toMatchObject({
      kind: "single-squadron",
      entry: { squadronId: "squadron:solo" },
    });
    if (destination.kind === "single-squadron") {
      await startSquadronDraft({
        entry: destination.entry,
        handleNewThread,
        selectDraftSquadron,
      });
    }
    expect(handleNewThread).toHaveBeenCalledWith(sharedFolder);
    expect(handleNewThread).not.toHaveBeenCalledWith(mostRecentFolder);
    expect(selectDraftSquadron).toHaveBeenCalledWith(
      scopedThreadKey(
        scopeThreadRef(sharedFolder.environmentId, ThreadId.make("thread:index-solo")),
      ),
      "squadron:solo",
    );
  });

  it("keys the command-palette Bravo carrier by its returned thread over Alpha's shared folder", async () => {
    const entries = buildSquadronPickerEntries({
      squadrons: [
        {
          squadron: { id: "squadron:alpha", name: "Alpha", createdAt: "2026-08-31T00:00:00Z" },
          projectIds: [sharedFolder.id],
        },
        {
          squadron: { id: "squadron:bravo", name: "Bravo", createdAt: "2026-08-31T00:00:00Z" },
          projectIds: [sharedFolder.id],
        },
      ],
      projects: [sharedFolder],
      primaryEnvironmentId: sharedFolder.environmentId,
    });
    const bravo = entries[1];
    const handleNewThread = vi.fn(async () => ({
      draftId: "draft:bravo",
      threadId: ThreadId.make("thread:bravo"),
    }));
    const selectDraftSquadron = vi.fn();

    await startSquadronDraft({ entry: bravo!, handleNewThread, selectDraftSquadron });

    expect(entries.map((entry) => entry.squadronId)).toEqual(["squadron:alpha", "squadron:bravo"]);
    expect(handleNewThread).toHaveBeenCalledWith(sharedFolder);
    expect(selectDraftSquadron).toHaveBeenCalledWith(
      scopedThreadKey(scopeThreadRef(sharedFolder.environmentId, ThreadId.make("thread:bravo"))),
      "squadron:bravo",
    );
    expect(
      filterThreadsForSquadronScope(
        [{ id: "thread:alpha" }, { id: "thread:bravo" }],
        { id: "squadron:bravo", name: "Bravo", projectIds: [sharedFolder.id] },
        new Map([
          ["thread:alpha", { kind: "known" as const, squadron: { id: "squadron:alpha" } }],
          ["thread:bravo", { kind: "known" as const, squadron: { id: "squadron:bravo" } }],
        ]),
      ).map((thread) => thread.id),
    ).toEqual(["thread:bravo"]);
  });

  it("keeps a missing folder unavailable instead of inventing a project-derived fallback", async () => {
    const [entry] = buildSquadronPickerEntries({
      squadrons: [
        {
          squadron: { id: "squadron:alpha", name: "Alpha", createdAt: "2026-08-31T00:00:00Z" },
          projectIds: [ProjectId.make("project:missing")],
        },
      ],
      projects: [sharedFolder],
      primaryEnvironmentId: sharedFolder.environmentId,
    });
    const handleNewThread = vi.fn();
    const selectDraftSquadron = vi.fn();

    await expect(
      startSquadronDraft({ entry: entry!, handleNewThread, selectDraftSquadron }),
    ).resolves.toBeNull();
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(selectDraftSquadron).not.toHaveBeenCalled();
  });
});

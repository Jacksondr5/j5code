import type { Project } from "../../types";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SquadronDirectoryState } from "./SquadronDirectory";
import type { ManagedSquadron } from "./squadronClient";

export type SquadronPickerEntry = {
  readonly squadronId: string;
  readonly name: string;
  /** The v0 folder is display/launch substrate, never the choice identity. */
  readonly folder: Pick<Project, "environmentId" | "id" | "title" | "workspaceRoot"> | null;
};

export type StartedSquadronDraft = {
  readonly draftId: string;
  readonly threadId: ThreadId;
};

/** Picker rows expose the Squadron identity alone; folders remain search and launch substrate. */
export const buildSquadronPickerRow = (entry: SquadronPickerEntry) => ({
  searchTerms: [entry.name, entry.folder?.title ?? "", entry.folder?.workspaceRoot ?? ""],
  title: entry.name,
  ...(entry.folder === null ? { disabled: true } : {}),
});

/** The only valid storage key for a newly-created Squadron-scoped draft. */
export function squadronDraftScopeKey(
  environmentId: EnvironmentId,
  draft: StartedSquadronDraft,
): string {
  return scopedThreadKey(scopeThreadRef(environmentId, draft.threadId));
}

/** A direct launch never stands in for a choice among multiple Registrar homes. */
export function canCreateThreadWithoutSquadronPicker(
  directoryStatus: SquadronDirectoryState["status"],
  squadronCount: number,
): boolean {
  return directoryStatus === "ready" && squadronCount === 1;
}

export function resolveNewThreadShortcutDestination(
  directoryStatus: SquadronDirectoryState["status"],
  entries: ReadonlyArray<SquadronPickerEntry>,
):
  | { readonly kind: "picker" }
  | { readonly kind: "single-squadron"; readonly entry: SquadronPickerEntry } {
  return directoryStatus === "ready" && entries.length === 1
    ? { kind: "single-squadron", entry: entries[0]! }
    : { kind: "picker" };
}

/**
 * A thread with a durable Registrar home keeps that home when it starts its
 * next draft. Threads without one may only use the ready/exact-one shortcut.
 */
export function resolveCurrentThreadNewThreadDestination(
  activeSquadronId: string | null,
  directoryStatus: SquadronDirectoryState["status"],
  entries: ReadonlyArray<SquadronPickerEntry>,
):
  | { readonly kind: "picker" }
  | { readonly kind: "single-squadron"; readonly entry: SquadronPickerEntry } {
  if (activeSquadronId !== null) {
    const entry = entries.find((candidate) => candidate.squadronId === activeSquadronId);
    return entry === undefined ? { kind: "picker" } : { kind: "single-squadron", entry };
  }
  return resolveNewThreadShortcutDestination(directoryStatus, entries);
}

/** The index route may only create a draft when a Registrar home is determinate. */
export function resolveIndexDraftDestination(
  selectedSquadronId: string | null,
  directoryStatus: SquadronDirectoryState["status"],
  entries: ReadonlyArray<SquadronPickerEntry>,
):
  | { readonly kind: "index" }
  | { readonly kind: "single-squadron"; readonly entry: SquadronPickerEntry } {
  const destination =
    selectedSquadronId === null
      ? resolveNewThreadShortcutDestination(directoryStatus, entries)
      : resolveCurrentThreadNewThreadDestination(selectedSquadronId, directoryStatus, entries);
  return destination.kind === "single-squadron" ? destination : { kind: "index" };
}

/**
 * Builds choices from the Registrar-backed directory. A missing primary folder
 * stays visible but unavailable; no project list is ever used to invent a Squadron.
 */
export function buildSquadronPickerEntries(input: {
  readonly squadrons: ReadonlyArray<ManagedSquadron>;
  readonly projects: ReadonlyArray<
    Pick<Project, "environmentId" | "id" | "title" | "workspaceRoot">
  >;
  readonly primaryEnvironmentId: string | null;
}): ReadonlyArray<SquadronPickerEntry> {
  return input.squadrons.map(({ squadron, projectIds }) => {
    const projectId = projectIds[0];
    const folder =
      projectId === undefined || input.primaryEnvironmentId === null
        ? null
        : (input.projects.find(
            (project) =>
              project.id === projectId && project.environmentId === input.primaryEnvironmentId,
          ) ?? null);
    return { squadronId: squadron.id, name: squadron.name, folder };
  });
}

/**
 * Reuses SQ1's explicit draft carrier after the ordinary draft route is ready.
 * The folder starts a draft; only the Squadron id scopes it.
 */
export async function startSquadronDraft(input: {
  readonly entry: SquadronPickerEntry;
  readonly handleNewThread: (
    project: NonNullable<SquadronPickerEntry["folder"]>,
  ) => Promise<StartedSquadronDraft | null>;
  readonly selectDraftSquadron: (draftKey: string, squadronId: string) => void;
}): Promise<StartedSquadronDraft | null> {
  if (input.entry.folder === null) return null;
  const draft = await input.handleNewThread(input.entry.folder);
  if (draft !== null) {
    input.selectDraftSquadron(
      squadronDraftScopeKey(input.entry.folder.environmentId, draft),
      input.entry.squadronId,
    );
  }
  return draft;
}

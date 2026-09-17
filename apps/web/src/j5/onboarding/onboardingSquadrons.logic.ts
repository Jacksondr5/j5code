import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import type { AssignImportedThreadsResponse, ScopedSquadronRef } from "@t3tools/contracts/j5";

import type { ScopedManagedSquadron } from "../squadron/SquadronDirectory";
import { squadronDraftScopeKey, type StartedSquadronDraft } from "../squadron/SquadronPicker.logic";

/**
 * Per-folder Squadron choice made on the onboarding Squadrons stage. `new` creates a Squadron
 * named by the person; `existing` homes the folder's imported conversations in a Squadron that
 * already references exactly this folder's project; `unconfirmed` records a create whose result
 * was lost, which blocks the import until the person picks an existing Squadron or explicitly
 * asks to create again. Nothing here is ever inferred from a name.
 */
export type OnboardingSquadronAssignment =
  | { readonly kind: "new"; readonly name: string }
  | { readonly kind: "existing"; readonly squadronId: string }
  | { readonly kind: "unconfirmed"; readonly name: string };

/** A Squadron that a folder's run already settled on. Locked for the rest of the wizard. */
export interface OnboardingSquadronHome {
  readonly squadronId: string;
  readonly name: string;
  readonly projectRef: ScopedProjectRef;
}

export type AssignImportedThreadsEntry = AssignImportedThreadsResponse["entries"][number];
export type AssignImportedThreadsStatus = AssignImportedThreadsEntry["status"];
export type AssignmentSummary = Readonly<Record<AssignImportedThreadsStatus, number>>;

/** What happened to one folder during the final import run. */
export type OnboardingFolderOutcome =
  | { readonly kind: "project_failed" }
  | { readonly kind: "squadron_failed"; readonly message: string }
  | { readonly kind: "squadron_unconfirmed" }
  | { readonly kind: "import_failed"; readonly squadronName: string }
  | { readonly kind: "assign_failed"; readonly squadronName: string; readonly message: string }
  | {
      readonly kind: "done";
      readonly squadronName: string;
      readonly importedCount: number;
      readonly skippedCount: number;
      readonly assignment: AssignmentSummary;
    };

export const defaultOnboardingAssignment = (candidate: {
  readonly title: string;
}): OnboardingSquadronAssignment => ({ kind: "new", name: candidate.title });

export const resolveOnboardingAssignment = (
  assignments: ReadonlyMap<string, OnboardingSquadronAssignment>,
  candidate: { readonly key: string; readonly title: string },
): OnboardingSquadronAssignment =>
  assignments.get(candidate.key) ?? defaultOnboardingAssignment(candidate);

/**
 * Existing Squadrons are offered only from the folder's own environment and only when they
 * reference exactly this folder's registered project and nothing else; the server refuses a
 * Squadron that references several projects even when one of them matches. A folder without
 * a project id yet has no eligible Squadrons: the same repository elsewhere is a different folder.
 */
export const eligibleExistingSquadrons = (
  squadrons: ReadonlyArray<ScopedManagedSquadron>,
  folder: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId | null },
): ReadonlyArray<ScopedManagedSquadron> => {
  if (folder.projectId === null) return [];
  return squadrons.filter(
    (squadron) =>
      squadron.environmentId === folder.environmentId &&
      squadron.projectIds.length === 1 &&
      squadron.projectIds[0] === folder.projectId,
  );
};

export type OnboardingSquadronsReadiness = "ready" | "empty-name" | "unconfirmed";

/** The final button stays disabled until every selected folder has an actionable choice. */
export const resolveOnboardingSquadronsReadiness = (
  selected: ReadonlyArray<{ readonly key: string; readonly title: string }>,
  assignments: ReadonlyMap<string, OnboardingSquadronAssignment>,
  homes: ReadonlyMap<string, OnboardingSquadronHome>,
): OnboardingSquadronsReadiness => {
  let readiness: OnboardingSquadronsReadiness = "ready";
  for (const candidate of selected) {
    if (homes.has(candidate.key)) continue;
    const assignment = resolveOnboardingAssignment(assignments, candidate);
    if (assignment.kind === "unconfirmed") return "unconfirmed";
    if (assignment.kind === "new" && assignment.name.trim().length === 0) {
      readiness = "empty-name";
    }
  }
  return readiness;
};

export type EnsureOnboardingSquadronResult =
  | { readonly kind: "ready"; readonly home: OnboardingSquadronHome }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Resolves the Squadron a folder's imported conversations will be homed in, creating it when the
 * choice is New. A remembered home wins over the current choice so a retry never creates twice.
 * A create whose response is lost is reported as unconfirmed and left for the person to resolve:
 * the server mints a fresh id per call and enforces no name uniqueness, so nothing can be matched
 * back safely. Only a definite rejection (4xx) counts as a plain failure that may be retried.
 */
export async function ensureOnboardingSquadron(input: {
  readonly key: string;
  readonly projectRef: ScopedProjectRef;
  readonly assignment: OnboardingSquadronAssignment;
  readonly homes: Map<string, OnboardingSquadronHome>;
  readonly existingSquadrons: ReadonlyArray<ScopedManagedSquadron>;
  readonly createSquadron: (
    environmentId: EnvironmentId,
    input: { readonly name: string; readonly projectId: ProjectId },
  ) => Promise<{ readonly squadron: { readonly id: string; readonly name: string } }>;
  readonly isDefiniteRejection: (error: unknown) => boolean;
}): Promise<EnsureOnboardingSquadronResult> {
  const remembered = input.homes.get(input.key);
  if (remembered !== undefined) return { kind: "ready", home: remembered };
  const { assignment, projectRef } = input;
  if (assignment.kind === "unconfirmed") return { kind: "unconfirmed" };
  if (assignment.kind === "existing") {
    const chosen = eligibleExistingSquadrons(input.existingSquadrons, {
      environmentId: projectRef.environmentId,
      projectId: projectRef.projectId,
    }).find((squadron) => squadron.squadron.id === assignment.squadronId);
    if (chosen === undefined) {
      return {
        kind: "failed",
        message: "That Squadron no longer references this folder. Choose another.",
      };
    }
    const home = { squadronId: chosen.squadron.id, name: chosen.squadron.name, projectRef };
    input.homes.set(input.key, home);
    return { kind: "ready", home };
  }
  const name = assignment.name.trim();
  if (name.length === 0) return { kind: "failed", message: "Name the Squadron first." };
  try {
    const created = await input.createSquadron(projectRef.environmentId, {
      name,
      projectId: projectRef.projectId,
    });
    const home = { squadronId: created.squadron.id, name: created.squadron.name, projectRef };
    input.homes.set(input.key, home);
    return { kind: "ready", home };
  } catch (error) {
    if (input.isDefiniteRejection(error)) {
      return {
        kind: "failed",
        message: error instanceof Error ? error.message : "Could not create the Squadron.",
      };
    }
    return { kind: "unconfirmed" };
  }
}

export const summarizeAssignmentEntries = (
  entries: ReadonlyArray<AssignImportedThreadsEntry>,
): AssignmentSummary => {
  const summary: Record<AssignImportedThreadsStatus, number> = {
    assigned: 0,
    already_assigned: 0,
    kept_elsewhere: 0,
    kept_retired: 0,
    kept_archived: 0,
    failed: 0,
  };
  for (const entry of entries) summary[entry.status] += 1;
  return summary;
};

/** Kept conversations are deliberate non-moves the person should see before the wizard leaves. */
export const hasKeptConversations = (summary: AssignmentSummary): boolean =>
  summary.kept_elsewhere + summary.kept_retired + summary.kept_archived > 0;

/** A folder is finished only when its import lost nothing and every conversation was homed or deliberately kept. */
export const isOnboardingFolderComplete = (outcome: OnboardingFolderOutcome): boolean =>
  outcome.kind === "done" && outcome.skippedCount === 0 && outcome.assignment.failed === 0;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Results copy per folder: the Squadron first, then what landed and what was kept. */
export const describeOnboardingFolderOutcome = (
  outcome: OnboardingFolderOutcome,
): { readonly headline: string; readonly detail: string | null } => {
  switch (outcome.kind) {
    case "project_failed":
      return { headline: "Could not add this folder.", detail: null };
    case "squadron_failed":
      return { headline: "Could not create the Squadron.", detail: outcome.message };
    case "squadron_unconfirmed":
      return {
        headline: "Couldn’t confirm the Squadron was created.",
        detail: "Refresh, then pick it under Existing or create it again.",
      };
    case "import_failed":
      return {
        headline: `${outcome.squadronName}: conversations could not be imported.`,
        detail: null,
      };
    case "assign_failed":
      return {
        headline: `${outcome.squadronName}: conversations could not be assigned.`,
        detail: outcome.message,
      };
    case "done": {
      const parts: string[] = [];
      const { assignment } = outcome;
      parts.push(`${plural(assignment.assigned, "conversation")} added`);
      if (assignment.already_assigned > 0)
        parts.push(`${assignment.already_assigned} already here`);
      if (assignment.kept_elsewhere > 0) {
        parts.push(`${assignment.kept_elsewhere} kept in another Squadron`);
      }
      if (assignment.kept_retired > 0) parts.push(`${assignment.kept_retired} kept (retired)`);
      if (assignment.kept_archived > 0) parts.push(`${assignment.kept_archived} kept (archived)`);
      if (assignment.failed > 0) parts.push(`${assignment.failed} could not be assigned`);
      if (outcome.skippedCount > 0) {
        parts.push(`${plural(outcome.skippedCount, "conversation")} could not be imported`);
      }
      return { headline: `${outcome.squadronName}: ${parts.join(" · ")}.`, detail: null };
    }
  }
};

/** The landing draft carries the Squadron of the folder the wizard lands on, never a guess. */
export const resolveOnboardingLandingSquadron = (
  projectRef: ScopedProjectRef,
  homes: ReadonlyMap<string, OnboardingSquadronHome>,
): ScopedSquadronRef | undefined => {
  for (const home of homes.values()) {
    if (
      home.projectRef.environmentId === projectRef.environmentId &&
      home.projectRef.projectId === projectRef.projectId
    ) {
      return { environmentId: home.projectRef.environmentId, squadronId: home.squadronId };
    }
  }
  return undefined;
};

/**
 * Mirrors `startSquadronDraft`: the folder starts the draft, then only the Squadron id scopes
 * it, so the first send carries an explicit home instead of stopping at the Squadron chip.
 */
export async function openOnboardingSquadronDraft(input: {
  readonly projectRef: ScopedProjectRef;
  readonly squadron: ScopedSquadronRef | undefined;
  readonly handleNewThread: (projectRef: ScopedProjectRef) => Promise<StartedSquadronDraft | null>;
  readonly selectDraftSquadron: (draftKey: string, squadronId: string) => void;
}): Promise<StartedSquadronDraft | null> {
  const draft = await input.handleNewThread(input.projectRef);
  if (draft !== null && input.squadron !== undefined) {
    input.selectDraftSquadron(
      squadronDraftScopeKey(input.projectRef.environmentId, draft),
      input.squadron.squadronId,
    );
  }
  return draft;
}

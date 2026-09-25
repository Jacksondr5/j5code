import { useSyncExternalStore } from "react";

/**
 * Open state for the one Create Squadron dialog (FORK.md case 19), which
 * `SquadronCreateDialogHost` mounts once in the app shell. Every door that adds a folder
 * (sidebar header, scope menu, empty states, the palette's Add project) opens it here, so
 * a folder is always chosen inside Create Squadron and never lands on a Squadron-less draft.
 */
let open = false;
const listeners = new Set<() => void>();

export function setSquadronCreateOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  listeners.forEach((listener) => listener());
}

export function openSquadronCreate(): void {
  setSquadronCreateOpen(true);
}

export function isSquadronCreateOpen(): boolean {
  return open;
}

export function subscribeSquadronCreateOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSquadronCreateOpen(): boolean {
  return useSyncExternalStore(subscribeSquadronCreateOpen, isSquadronCreateOpen, () => false);
}

/**
 * Where the command palette's Add project doors go. Only a J5 flow that asked for a folder
 * back (case 13's `onProjectSelected`, case 42's `sourcePicker`) browses for one; every
 * other door opens Create Squadron, whose own "Choose folder" returns here with a carrier.
 */
export function resolveAddProjectDoor(carriers: {
  readonly onProjectSelected?: unknown;
  readonly sourcePicker?: unknown;
}): "pick-folder" | "create-squadron" {
  return carriers.onProjectSelected !== undefined || carriers.sourcePicker !== undefined
    ? "pick-folder"
    : "create-squadron";
}

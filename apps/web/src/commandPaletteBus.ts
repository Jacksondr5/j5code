import type { ScopedProjectRef } from "@t3tools/contracts";

// Tiny event bus allowing components to programmatically open the command palette
// without owning its React state.
const COMMAND_PALETTE_OPEN_EVENT = "t3code:open-command-palette";

/** A picker result remains explicit about both the durable project and its human folder details. */
export interface CommandPaletteProjectSelection {
  readonly projectRef: ScopedProjectRef;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  /**
   * Opts into returning the normal Add Project picker result instead of opening a thread.
   * Absent callers retain the normal Add Project navigation behavior.
   */
  readonly onProjectSelected?: (selection: CommandPaletteProjectSelection) => void;
}

/** Returns whether an opt-in caller consumed the selection. */
export function returnCommandPaletteProjectSelection(
  onProjectSelected: ((selection: CommandPaletteProjectSelection) => void) | undefined,
  selection: CommandPaletteProjectSelection,
): boolean {
  if (onProjectSelected === undefined) return false;
  onProjectSelected(selection);
  return true;
}

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

/** Read at event time so consumers do not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}

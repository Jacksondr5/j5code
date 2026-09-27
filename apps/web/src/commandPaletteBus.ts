import type { ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentId, PullRequestLinkedThreadsResult } from "@t3tools/contracts";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

// Tiny event bus allowing components to programmatically open the command palette
// without owning its React state.
const COMMAND_PALETTE_OPEN_EVENT = "t3code:open-command-palette";

/** A picker result remains explicit about both the durable project and its human folder details. */
export interface CommandPaletteProjectSelection {
  readonly projectRef: ScopedProjectRef;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface CommandPaletteSourcePicker {
  readonly environmentId: EnvironmentId;
  readonly onSelect: (source: string) => void;
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
  /**
   * Opts into returning the normal Add Project picker result instead of opening a thread.
   * J5: without this or `sourcePicker`, Add Project opens Create Squadron instead (case 13).
   */
  readonly onProjectSelected?: (selection: CommandPaletteProjectSelection) => void;
  /** Select an existing folder or repository URL without creating a project or cloning. */
  readonly sourcePicker?: CommandPaletteSourcePicker;
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

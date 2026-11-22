import { isMacPlatform, resolveEventKeys } from "@t3tools/shared/keybindings";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

// apps/desktop/src/j5/FindBar.ts reads both markers and the frame name.
const SURFACE_ATTRIBUTE = "data-j5-artifacts-surface";
const FIND_AREA_ATTRIBUTE = "data-j5-artifact-find-area";
/** Returning to the window leaves focus in the artifact rather than moving it to the composer. */
export const ARTIFACTS_SURFACE_SELECTOR = `[${SURFACE_ATTRIBUTE}]`;
/** The HTML artifact's iframe, whose Cmd/Ctrl+F the desktop app takes before it reaches the frame. */
export const ARTIFACT_PREVIEW_FRAME_NAME = "j5-artifact-preview";

/**
 * Cmd+F on macOS, Ctrl+F elsewhere, as the browser finds: by the layout's letter, or by the physical
 * F key on a non-Latin layout. The desktop bar opens on the same key.
 */
function isFindKey(
  event: Pick<KeyboardEvent, "key" | "code" | "altKey" | "shiftKey" | "metaKey" | "ctrlKey">,
) {
  if (event.altKey || event.shiftKey || !resolveEventKeys(event).has("f")) return false;
  return isMacPlatform(navigator.platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/** On desktop, which has no find of its own, Cmd/Ctrl+F opens the window's find bar over the artifact. */
function openDesktopFind(event: ReactKeyboardEvent<HTMLElement>): void {
  const bridge = window.desktopBridge;
  if (bridge === undefined || event.defaultPrevented || !isFindKey(event)) return;
  event.preventDefault();
  const area = (
    event.currentTarget.querySelector(`[${FIND_AREA_ATTRIBUTE}]`) ?? event.currentTarget
  ).getBoundingClientRect();
  void bridge.setFindBar({ x: area.x, y: area.y, width: area.width, height: area.height });
}

/** Closes the desktop find bar when the surface unmounts; the window ignores it when none is open. */
export function closeDesktopFind(): void {
  void window.desktopBridge?.setFindBar(null);
}

/** Spread on the root of the Artifacts surface: the right-panel tab and the `/artifacts` route. */
export const artifactsSurfaceProps = { [SURFACE_ATTRIBUTE]: "", onKeyDown: openDesktopFind };

/** Spread on the artifact's preview: the desktop find bar sits at its top right. */
export const artifactFindAreaProps = { [FIND_AREA_ATTRIBUTE]: "" };

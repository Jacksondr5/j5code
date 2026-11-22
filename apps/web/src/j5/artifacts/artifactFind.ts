import type { KeyboardEvent as ReactKeyboardEvent } from "react";

// apps/desktop/src/j5/FindBar.ts reads both markers for Cmd/Ctrl+F inside an HTML artifact's iframe.
const SURFACE_ATTRIBUTE = "data-j5-artifacts-surface";
const FIND_AREA_ATTRIBUTE = "data-j5-artifact-find-area";

function isFindKey(event: ReactKeyboardEvent, platform: string): boolean {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return false;
  return platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** On desktop, which has no find of its own, Cmd/Ctrl+F opens the window's find bar over the artifact. */
function openDesktopFind(event: ReactKeyboardEvent<HTMLElement>): void {
  const bridge = window.desktopBridge;
  if (bridge === undefined || event.defaultPrevented) return;
  if (!isFindKey(event, bridge.getClientPlatform())) return;
  event.preventDefault();
  const area = (
    event.currentTarget.querySelector(`[${FIND_AREA_ATTRIBUTE}]`) ?? event.currentTarget
  ).getBoundingClientRect();
  void bridge.openFindBar({ x: area.x, y: area.y, width: area.width, height: area.height });
}

/** Spread on the root of the Artifacts surface: the right-panel tab and the `/artifacts` route. */
export const artifactsSurfaceProps = { [SURFACE_ATTRIBUTE]: "", onKeyDown: openDesktopFind };

/** Spread on the artifact's preview: the desktop find bar sits at its top right. */
export const artifactFindAreaProps = { [FIND_AREA_ATTRIBUTE]: "" };

function isInArtifactsSurface(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest(`[${SURFACE_ATTRIBUTE}]`) !== null;
}

/**
 * Whether a find key belongs to the artifact the person is reading rather than to thread find:
 * the key event started in the Artifacts surface, or the surface holds focus.
 */
export function isArtifactFindKey(event: KeyboardEvent, focused: Element | null): boolean {
  return isInArtifactsSurface(event.target) || isInArtifactsSurface(focused);
}

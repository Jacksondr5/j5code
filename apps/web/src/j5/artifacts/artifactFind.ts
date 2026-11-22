/** Spread on the root of the Artifacts surface: the right-panel tab and the `/artifacts` route. */
export const artifactsSurfaceProps = { "data-j5-artifacts-surface": "" } as const;

function isInArtifactsSurface(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest("[data-j5-artifacts-surface]") !== null;
}

/**
 * Whether a find key belongs to the artifact the person is reading rather than to thread find:
 * the key event started in the Artifacts surface, or the surface holds focus.
 */
export function isArtifactFindKey(event: KeyboardEvent, focused: Element | null): boolean {
  return isInArtifactsSurface(event.target) || isInArtifactsSurface(focused);
}

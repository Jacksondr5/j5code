/**
 * Whether the locked-down artifact view lets a page load: only the artifact itself and its
 * in-page anchors. Links, form posts, refreshes and frames go nowhere, as no navigation leaves
 * web's sandboxed frame either.
 */
export const artifactHtmlLoadAllowed = (url: string): boolean =>
  url === "about:blank" || url.startsWith("about:blank#");

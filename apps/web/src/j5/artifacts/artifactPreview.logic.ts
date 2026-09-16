/**
 * When the selected artifact's body must be read again. The list carries each file's size and
 * modification time, so a change to the selected file shows up there; a change to any other file
 * refreshes the list but must not re-read this body. The person's Refresh button is the one other
 * trigger, because modifiedAt may be null and a same-size rewrite is invisible to the size.
 */
export const artifactPreviewRevision = (
  entry: { readonly modifiedAt: string | null; readonly byteLength: number } | undefined,
  manualRefreshes: number,
): string => `${entry?.modifiedAt ?? ""}:${entry?.byteLength ?? ""}:${manualRefreshes}`;

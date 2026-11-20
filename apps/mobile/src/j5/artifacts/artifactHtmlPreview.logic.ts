const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/**
 * The page the artifact view loads: the artifact inside the frame web uses (`sandbox=""`, no
 * referrer), so the browser engine, not the WebView's settings, refuses its scripts, forms,
 * popups and navigation. The page under the frame is white, the canvas a browser tab gives a
 * page that sets no colours; an artifact's own background covers it.
 */
export const artifactHtmlFrameDocument = (html: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(html)}"></iframe></body></html>`;

/**
 * Whether the artifact view lets a load through: anything inside the artifact's frame, which
 * `sandbox=""` already bounds as on web, and nothing at the top but the page and its anchors.
 */
export const artifactHtmlLoadAllowed = (request: {
  readonly url: string;
  readonly isTopFrame?: boolean;
}): boolean =>
  request.isTopFrame === false ||
  request.url === "about:blank" ||
  request.url.startsWith("about:blank#");

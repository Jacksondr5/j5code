import { type PromptLinkResult, promptLinkDeepLink } from "@t3tools/shared/promptLinks";

export interface ThreadLinkPage {
  /** The thread's path in a J5 web app, `/<environment>/<thread>`. */
  readonly appPath: string;
  readonly deepLink: string;
}

// The characters a copied thread link escapes its ids into (upstream's `hostedThreadLink`).
const THREAD_LINK_PATH = /^\/threads\/([A-Za-z0-9_%-]+)\/([A-Za-z0-9_%-]+)$/;

const isId = (segment: string) => {
  try {
    return decodeURIComponent(segment).trim().length > 0;
  } catch {
    return false;
  }
};

/** Reads a copied thread link, `j5.codes/threads/<environment>/<thread>`, as the page shows it. */
export function readThreadLinkPage(href: string): PromptLinkResult<ThreadLinkPage> {
  // Static hosting serves the page with a trailing slash as well as without.
  const match = THREAD_LINK_PATH.exec(new URL(href).pathname.replace(/\/+$/, ""));
  if (!match || !isId(match[1]!) || !isId(match[2]!)) {
    return { ok: false, error: "This link doesn't name a thread." };
  }
  // The ids stay escaped as the link wrote them; the app decodes them.
  // Every J5 server opens `/<environment>/<thread>`, including those older than `/threads/…`.
  const appPath = `/${match[1]}/${match[2]}`;
  return { ok: true, value: { appPath, deepLink: promptLinkDeepLink(appPath) } };
}

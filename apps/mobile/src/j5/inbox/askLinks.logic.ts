import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadLinkHref, type ThreadLink } from "@t3tools/shared/threadLinks";

/**
 * Where a link in an ask goes, as a thread sends it: a thread link opens that thread, a web link
 * goes to the pull request route (which opens the browser for anything but a known project's pull
 * request), and anything else is left to the caller. A thread link that names no environment is
 * read in the ask's own, as a thread reads it in its message's.
 */
export function askLinkTarget(
  href: string,
  askEnvironmentId: EnvironmentId,
  resolve: (link: ThreadLink) => ScopedThreadRef | null,
):
  | { readonly kind: "thread"; readonly thread: ScopedThreadRef | null }
  | { readonly kind: "web" }
  | null {
  const link = parseThreadLinkHref(href);
  if (link !== null) {
    const resolved = resolve(link);
    return {
      kind: "thread",
      thread:
        resolved ??
        (link.environmentId === null ? scopeThreadRef(askEnvironmentId, link.threadId) : null),
    };
  }
  return /^https?:\/\//i.test(href) ? { kind: "web" } : null;
}

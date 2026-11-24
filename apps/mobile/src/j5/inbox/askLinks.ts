import type { EnvironmentId } from "@t3tools/contracts";

import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { appAtomRegistry } from "../../state/atom-registry";
import { resolveThreadLink } from "../../state/entities";
import { askLinkTarget } from "./askLinks.logic";

/** Opens a link in an ask the way the ask's thread would; false leaves it to the caller. */
export function useOpenAskLink(ask: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}) {
  const openPullRequest = useOpenPullRequest({
    context: { environmentId: String(ask.environmentId), projectId: ask.projectId },
  });
  const openLinkedThread = useOpenLinkedThread();
  return (href: string): boolean => {
    const target = askLinkTarget(href, ask.environmentId, (link) =>
      resolveThreadLink((atom) => appAtomRegistry.get(atom), link, ask.environmentId),
    );
    if (target === null) return false;
    if (target.kind === "web") void openPullRequest(href);
    else if (target.thread !== null) {
      openLinkedThread({
        environmentId: String(target.thread.environmentId),
        threadId: String(target.thread.threadId),
      });
    }
    return true;
  };
}

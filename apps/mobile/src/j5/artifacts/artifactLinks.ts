import { artifactPathFromWorkspaceRelativePath } from "@t3tools/client-runtime/j5/artifacts";

import {
  fileRoutePathSegments,
  resolveWorkspaceRelativeFilePath,
} from "../../features/files/filePath";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";

/** The artifact a chat link names (`artifacts/…` in the thread's workspace), or null. */
export function artifactPathForMarkdownLink(
  href: string,
  workspaceRoot: string | null | undefined,
): string | null {
  const presentation = resolveMarkdownLinkPresentation(href);
  if (presentation.kind !== "file") return null;
  return artifactPathFromWorkspaceRelativePath(
    resolveWorkspaceRelativeFilePath(workspaceRoot, presentation.path),
  );
}

/**
 * Opens an `artifacts/…` link in J5's artifact viewer instead of as a workspace file, which
 * isn't there: artifacts live in the server's state, not the repository. False for any other link.
 */
export function openArtifactLink(
  href: string,
  thread: {
    readonly navigation: { readonly navigate: (route: "ThreadArtifact", params: object) => void };
    readonly environmentId: string;
    readonly threadId: string;
    readonly workspaceRoot: string | null | undefined;
  },
): boolean {
  const path = artifactPathForMarkdownLink(href, thread.workspaceRoot);
  if (path === null) return false;
  thread.navigation.navigate("ThreadArtifact", {
    environmentId: thread.environmentId,
    threadId: thread.threadId,
    path: fileRoutePathSegments(path),
  });
  return true;
}

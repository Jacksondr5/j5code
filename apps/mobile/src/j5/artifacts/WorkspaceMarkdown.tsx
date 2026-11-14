import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useNavigation } from "@react-navigation/native";

import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import {
  fileRoutePathSegments,
  resolveWorkspaceRelativeFilePath,
} from "../../features/files/filePath";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { useProject, useThreadShell } from "../../state/entities";
import {
  artifactLinkContextMenu,
  onArtifactLinkMenuAction,
  openArtifactLink,
  type ArtifactLinkContext,
} from "./artifactLinks";

/**
 * Markdown read in one thread's workspace: `artifacts/…` links open J5's artifact viewer, as on
 * web, other file links open the file from the workspace root, and images resolve from it.
 */
export function WorkspaceMarkdown(props: {
  readonly markdown: string;
  readonly links: ArtifactLinkContext & { readonly workspaceRoot: string };
}) {
  const navigation = useNavigation();
  const styles = useMarkdownPreviewStyles();
  const { links } = props;
  const resolveImageSource = useMarkdownImageSource({
    environmentId: links.environmentId as EnvironmentId,
    threadId: ThreadId.make(links.threadId),
    workspaceRoot: links.workspaceRoot,
  });
  const onLinkPress = (href: string) => {
    if (openArtifactLink(href, links)) return;
    const presentation = resolveMarkdownLinkPresentation(href);
    const relativePath =
      presentation.kind === "file"
        ? resolveWorkspaceRelativeFilePath(links.workspaceRoot, presentation.path)
        : null;
    if (relativePath !== null) {
      navigation.navigate("ThreadFile", {
        environmentId: links.environmentId,
        threadId: links.threadId,
        path: fileRoutePathSegments(relativePath),
      });
      return;
    }
    if (presentation.href) void tryOpenExternalUrl(presentation.href, "markdown-link");
  };
  return (
    <SelectableMarkdownText
      markdown={props.markdown}
      textStyle={styles.nativeTextStyle}
      resolveImageSource={resolveImageSource}
      onLinkPress={onLinkPress}
      fileContextMenu={(href) => artifactLinkContextMenu(href, links.workspaceRoot)}
      onFileContextMenuAction={(href, actionId) => onArtifactLinkMenuAction(href, actionId, links)}
    />
  );
}

/**
 * An agent's words to a person, read as web reads them: in the sender's thread and its worktree
 * (or its project's root). Without a sender thread on this device, the links stay plain text.
 */
export function SenderMarkdown(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly senderThreadId: string | null;
}) {
  const navigation = useNavigation();
  const styles = useMarkdownPreviewStyles();
  const thread = useThreadShell(
    props.senderThreadId === null
      ? null
      : scopeThreadRef(props.environmentId, ThreadId.make(props.senderThreadId)),
  );
  const project = useProject(scopeProjectRef(props.environmentId, ProjectId.make(props.projectId)));
  if (props.senderThreadId === null || project === null) {
    return <SelectableMarkdownText markdown={props.markdown} textStyle={styles.nativeTextStyle} />;
  }
  return (
    <WorkspaceMarkdown
      markdown={props.markdown}
      links={{
        navigation,
        environmentId: String(props.environmentId),
        threadId: props.senderThreadId,
        workspaceRoot: projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: thread?.worktreePath ?? null,
        }),
      }}
    />
  );
}

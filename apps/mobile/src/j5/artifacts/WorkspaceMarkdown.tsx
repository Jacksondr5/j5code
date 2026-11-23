import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";

import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import {
  fileRoutePathSegments,
  resolveWorkspaceRelativeFilePath,
} from "../../features/files/filePath";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "../../features/threads/ThreadMarkdownImage";
import {
  normalizeNativeMarkdownUrl,
  resolveMarkdownLinkPresentation,
} from "../../lib/markdownLinks";
import { resolveMobileMarkdownMediaSource } from "../../lib/markdownMediaSource";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  type MarkdownImageRenderer,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { useThreadCwd } from "./useThreadCwd";
import {
  artifactLinkContextMenu,
  onArtifactLinkMenuAction,
  openArtifactLink,
  type ArtifactLinkContext,
} from "./artifactLinks";
import { withBlockImages } from "./blockImages";

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
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  // Images draw at their own size within the width, as the timeline's do; a press opens them.
  const renderImage: MarkdownImageRenderer = (image) => {
    const media = resolveMobileMarkdownMediaSource(image.href, {
      threadId: ThreadId.make(links.threadId),
      workspaceRoot: links.workspaceRoot,
      imageEmbed: true,
    });
    if (media === null || media.kind !== "image") return null;
    if (media.access === "direct") {
      return (
        <ThreadMarkdownImageView
          uri={normalizeNativeMarkdownUrl(media.uri)}
          sourceKey={media.uri}
          unavailable={false}
          alt={image.alt}
          format={media.mimeType === "image/svg+xml" ? "svg" : undefined}
          onPressPreview={setPreview}
        />
      );
    }
    if (media.access === "unavailable") return <ThreadMarkdownImageUnavailable alt={image.alt} />;
    return (
      <ThreadMarkdownImage
        environmentId={links.environmentId as EnvironmentId}
        resource={media.resource}
        alt={image.alt}
        srcFragment={media.srcFragment}
        onPressPreview={setPreview}
      />
    );
  };
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
    <>
      <SelectableMarkdownText
        markdown={withBlockImages(props.markdown)}
        textStyle={styles.nativeTextStyle}
        renderImage={renderImage}
        resolveImageSource={resolveImageSource}
        onLinkPress={onLinkPress}
        fileContextMenu={(href) => artifactLinkContextMenu(href, links.workspaceRoot)}
        onFileContextMenuAction={(href, actionId) =>
          onArtifactLinkMenuAction(href, actionId, links)
        }
      />
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </>
  );
}

/**
 * An agent's words to a person, read as web reads them: in the sender's thread and its worktree
 * (or its project's root). Until that is known on this device, the links stay plain text.
 */
export function SenderMarkdown(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly senderThreadId: string | null;
}) {
  const navigation = useNavigation();
  const styles = useMarkdownPreviewStyles();
  // Loads the thread when its shell isn't here, so a worktree's links never resolve in the root.
  const workspaceRoot = useThreadCwd(
    props.senderThreadId === null
      ? null
      : scopeThreadRef(props.environmentId, ThreadId.make(props.senderThreadId)),
  );
  if (props.senderThreadId === null || workspaceRoot === null) {
    return <SelectableMarkdownText markdown={props.markdown} textStyle={styles.nativeTextStyle} />;
  }
  return (
    <WorkspaceMarkdown
      markdown={props.markdown}
      links={{
        navigation,
        environmentId: String(props.environmentId),
        threadId: props.senderThreadId,
        workspaceRoot,
      }}
    />
  );
}

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
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
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentThread } from "../../state/threads";
import { ArtifactMarkdownImage } from "./ArtifactMarkdownImage";
import { useOpenAskLink } from "../inbox/askLinks";
import { pressAskLinkWithoutWorkspace } from "../inbox/askLinks.logic";
import { useThreadCwd } from "./useThreadCwd";
import {
  artifactLinkContextMenu,
  artifactPathForMarkdownLink,
  onArtifactLinkMenuAction,
  openArtifactLink,
  type ArtifactLinkContext,
} from "./artifactLinks";
import { withBlockImages } from "./blockImages";

/**
 * Markdown read in one thread's workspace: `artifacts/…` links and images come from J5's artifact
 * store, as on web, other file links open the file from the workspace root, and images resolve
 * from it. Artifacts belong to the thread's project; with none known, their images are unavailable.
 */
export function WorkspaceMarkdown(props: {
  readonly markdown: string;
  readonly links: ArtifactLinkContext & {
    readonly workspaceRoot: string;
    readonly projectId: ProjectId | null;
  };
  /** Opens a link no workspace file names, as a thread would; false falls back to the browser. */
  readonly openLink?: (href: string) => boolean;
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
    const artifactPath = artifactPathForMarkdownLink(image.href, links.workspaceRoot);
    if (artifactPath !== null) {
      return links.projectId === null ? (
        <ThreadMarkdownImageUnavailable alt={image.alt} />
      ) : (
        <ArtifactMarkdownImage
          environmentId={links.environmentId as EnvironmentId}
          projectId={links.projectId}
          path={artifactPath}
          alt={image.alt}
          onPressPreview={setPreview}
        />
      );
    }
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
    if (!presentation.href || props.openLink?.(presentation.href) === true) return;
    void tryOpenExternalUrl(presentation.href, "markdown-link");
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
 * (or its project's root), with pull request and thread links opening in the app as they do in a
 * thread. Until that is known on this device, file links stay inert and the rest open as they can.
 */
export function SenderMarkdown(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  /** The ask's project, which places its pull request links. */
  readonly projectId: string;
  readonly senderThreadId: string | null;
}) {
  const navigation = useNavigation();
  const styles = useMarkdownPreviewStyles();
  const openLink = useOpenAskLink({
    environmentId: props.environmentId,
    projectId: props.projectId,
  });
  const senderThread =
    props.senderThreadId === null
      ? null
      : scopeThreadRef(props.environmentId, ThreadId.make(props.senderThreadId));
  // Loads the thread when its shell isn't here, so a worktree's links never resolve in the root.
  const workspaceRoot = useThreadCwd(senderThread);
  const projectId = useThreadProjectId(senderThread);
  if (props.senderThreadId === null || workspaceRoot === null) {
    return (
      <SelectableMarkdownText
        markdown={props.markdown}
        textStyle={styles.nativeTextStyle}
        onLinkPress={(href) =>
          pressAskLinkWithoutWorkspace(href, openLink, (url) => {
            void tryOpenExternalUrl(url, "markdown-link");
          })
        }
      />
    );
  }
  return (
    <WorkspaceMarkdown
      markdown={props.markdown}
      links={{
        navigation,
        environmentId: String(props.environmentId),
        threadId: props.senderThreadId,
        workspaceRoot,
        projectId,
      }}
      openLink={openLink}
    />
  );
}

/** The thread's project, from its shell or, when that isn't here, the thread itself. */
function useThreadProjectId(ref: ScopedThreadRef | null): ProjectId | null {
  const shell = useQuietThreadShell(ref);
  const detail = useEnvironmentThread(
    shell === null ? (ref?.environmentId ?? null) : null,
    shell === null ? (ref?.threadId ?? null) : null,
  );
  return shell?.projectId ?? Option.getOrNull(detail.data)?.thread.projectId ?? null;
}

import {
  artifactDataUrl,
  artifactExtension,
  artifactPreviewKind,
} from "@t3tools/client-runtime/j5/artifacts";
import type { ArtifactContent, ArtifactEntry, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Platform, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { AppBar } from "../../components/ui/AppBar";
import { AppText } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { fileRoutePathSegments } from "../../features/files/filePath";
import { ThreadMarkdownImageView } from "../../features/threads/ThreadMarkdownImage";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { relativeTime } from "../../lib/time";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { useThreadSelection } from "../../state/use-thread-selection";
import { listArtifacts, readArtifact } from "./artifactClient";
import { useServerRead } from "./serverRead";
import { ArtifactHtmlPreview } from "./ArtifactHtmlPreview";
import { WorkspaceMarkdown } from "./WorkspaceMarkdown";

type ThreadArtifactsParams = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type ThreadArtifactParams = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  /** Missing when an app link names no artifact. */
  readonly path?: string | string[];
}>;

/** Artifacts belong to the thread's project, on the thread's server. */
function useArtifactProject(params: { readonly environmentId: string }) {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const projectId = selectedThread?.projectId ?? null;
  return {
    environmentId: params.environmentId as EnvironmentId,
    projectId: projectId as ProjectId | null,
    title: selectedThreadProject?.title,
  };
}

/** Back as upstream's file viewer does: to the screen below, or to the thread from a link. */
function useBack(params: { readonly environmentId: string; readonly threadId: string }) {
  const navigation = useNavigation();
  return () => {
    if (navigation.canGoBack()) navigation.goBack();
    else
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: params.environmentId,
          threadId: params.threadId,
        }),
      );
  };
}

const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function ThreadArtifactsScreen(props: ThreadArtifactsParams) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const project = useArtifactProject(props.route.params);
  const back = useBack(props.route.params);
  const { load, refreshing, refresh } = useServerRead<ReadonlyArray<ArtifactEntry>>(
    project.projectId === null ? null : `${environmentId}:${project.projectId}`,
    () => listArtifacts({ environmentId: project.environmentId, projectId: project.projectId! }),
  );
  return (
    <View className="flex-1 bg-sheet">
      <AppBar title="Artifacts" subtitle={project.title} onBack={back} hideBottomBorder />
      <ScreenContent>
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-sheet"
          contentContainerClassName="gap-4 px-4 py-4"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        >
          {project.projectId === null ? (
            <EmptyState title="Artifacts unavailable" detail="This thread has no project." />
          ) : load.status === "loading" ? (
            <AppText className="text-foreground-muted">Loading artifacts…</AppText>
          ) : load.status === "error" ? (
            <EmptyState title="Couldn't read artifacts" detail={load.message} />
          ) : load.value.length === 0 ? (
            <EmptyState
              title="No artifacts yet"
              detail="Plans, specs and handoffs that agents write in this project appear here."
            />
          ) : (
            <ListSection title="This project">
              {load.value.map((entry) => (
                <ListRow
                  key={entry.path}
                  icon="doc.text"
                  label={entry.path}
                  detail={[
                    sizeLabel(entry.byteLength),
                    entry.modifiedAt === null ? null : relativeTime(entry.modifiedAt),
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                  onPress={() =>
                    navigation.dispatch(
                      StackActions.push("ThreadArtifact", {
                        environmentId,
                        threadId,
                        path: fileRoutePathSegments(entry.path),
                      }),
                    )
                  }
                />
              ))}
            </ListSection>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function ArtifactBody(props: { readonly content: ArtifactContent; readonly frameHeight: number }) {
  const { content } = props;
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const kind = artifactPreviewKind(content);
  if (kind === "image") {
    const svg = artifactExtension(content.path) === "svg";
    const image = (
      <ThreadMarkdownImageView
        uri={artifactDataUrl(content)}
        sourceKey={content.path}
        unavailable={false}
        alt={content.path}
        format={svg ? "svg" : undefined}
        onPressPreview={(source) => setPreview({ ...source, name: content.path.split("/").at(-1) })}
      />
    );
    // Upstream's Android full-screen viewer can't draw SVG, so there an SVG is only an image.
    if (svg && Platform.OS === "android") {
      return (
        <View
          pointerEvents="none"
          accessible
          accessibilityRole="image"
          accessibilityLabel={content.path}
        >
          <View collapsable={false} importantForAccessibility="no-hide-descendants">
            {image}
          </View>
        </View>
      );
    }
    return (
      <>
        {image}
        <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
      </>
    );
  }
  if (kind === "binary") {
    return (
      <EmptyState
        title="No preview"
        detail="This artifact isn't text or an image. Open it on web or desktop."
      />
    );
  }
  if (kind === "html") {
    return (
      <ArtifactHtmlPreview html={content.content} path={content.path} height={props.frameHeight} />
    );
  }
  return (
    <AppText
      className="text-sm text-foreground ios:font-[family-name:Menlo] android:font-mono"
      selectable
    >
      {content.content}
    </AppText>
  );
}

export function ThreadArtifactScreen(props: ThreadArtifactParams) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const routePath = props.route.params.path;
  const path = (Array.isArray(routePath) ? routePath.join("/") : routePath) || null;
  const project = useArtifactProject(props.route.params);
  const back = useBack(props.route.params);
  const { selectedThreadProject } = useThreadSelection();
  const workspaceRoot =
    (selectedThreadProject as { readonly workspaceRoot?: string } | null)?.workspaceRoot ?? null;
  const { load, refreshing, refresh } = useServerRead<ArtifactContent>(
    project.projectId === null || path === null
      ? null
      : `${environmentId}:${project.projectId}:${path}`,
    () =>
      readArtifact({
        environmentId: project.environmentId,
        projectId: project.projectId!,
        path: path!,
      }),
  );
  const columnMetrics = useNativeColumnLayoutMetrics();
  const insets = useSafeAreaInsets();
  const [viewportHeight, setViewportHeight] = useState(0);
  // The HTML frame fills the room the scroll view shows, so it scrolls inside without the page
  // scrolling first. iOS's header floats over the scroll view; Android's AppBar sits above it.
  const headerInset = Platform.OS === "ios" ? (columnMetrics?.safeArea.top ?? insets.top) : 0;
  const frameHeight = Math.max(320, viewportHeight - headerInset - insets.bottom - 28);
  const fullPath = `artifacts/${path ?? ""}`;
  const directory = fullPath.slice(0, fullPath.lastIndexOf("/"));
  return (
    <View className="flex-1 bg-sheet">
      <AppBar
        title={path?.split("/").at(-1) ?? "Artifact"}
        subtitle={path === null ? undefined : directory}
        onBack={back}
        hideBottomBorder
        menus={[
          {
            title: "Artifact actions",
            icon: "ellipsis",
            separateBackground: false,
            items: [
              {
                id: "all-artifacts",
                title: "All artifacts",
                icon: "list.bullet",
                onPress: () => navigation.navigate("ThreadArtifacts", { environmentId, threadId }),
              },
              ...(path === null
                ? []
                : [
                    {
                      id: "copy-path",
                      title: "Copy path",
                      icon: "doc.on.doc",
                      onPress: () => copyTextWithHaptic(fullPath),
                    },
                  ]),
            ],
          },
        ]}
      />
      <ScreenContent>
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-sheet"
          contentContainerClassName="gap-4 px-4 py-4"
          onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        >
          {path === null ? (
            <EmptyState title="Couldn't open this artifact" detail="This link names no artifact." />
          ) : project.projectId === null ? (
            <EmptyState title="Artifact unavailable" detail="This thread has no project." />
          ) : load.status === "loading" ? (
            <AppText className="text-foreground-muted">Opening artifact…</AppText>
          ) : load.status === "error" ? (
            <EmptyState title="Couldn't open this artifact" detail={load.message} />
          ) : load.value.content.length === 0 ? (
            <EmptyState
              variant="plain"
              title="This artifact is empty"
              detail="It has no content."
            />
          ) : artifactPreviewKind(load.value) === "markdown" && workspaceRoot !== null ? (
            <WorkspaceMarkdown
              markdown={load.value.content}
              links={{ navigation, environmentId, threadId, workspaceRoot }}
            />
          ) : (
            <ArtifactBody content={load.value} frameHeight={frameHeight} />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

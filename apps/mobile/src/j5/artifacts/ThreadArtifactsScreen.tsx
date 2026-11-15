import {
  artifactDataUrl,
  artifactExtension,
  artifactPreviewKind,
} from "@t3tools/client-runtime/j5/artifacts";
import type { ArtifactContent, ArtifactEntry, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { RefreshControl, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { fileRoutePathSegments } from "../../features/files/filePath";
import { ThreadMarkdownImageView } from "../../features/threads/ThreadMarkdownImage";
import { relativeTime } from "../../lib/time";
import { NativeStackScreenOptions } from "../../native/StackHeader";
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
  readonly path: string | string[];
}>;

/** Artifacts belong to the thread's project, on the thread's server. */
function useArtifactProject(params: { readonly environmentId: string }) {
  const { selectedThread } = useThreadSelection();
  const projectId = selectedThread?.projectId ?? null;
  return {
    environmentId: params.environmentId as EnvironmentId,
    projectId: projectId as ProjectId | null,
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
  const { load, refreshing, refresh } = useServerRead<ReadonlyArray<ArtifactEntry>>(
    project.projectId === null ? null : `${environmentId}:${project.projectId}`,
    () => listArtifacts({ environmentId: project.environmentId, projectId: project.projectId! }),
  );
  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-4 px-4 py-4"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      <NativeStackScreenOptions options={{ title: "Artifacts" }} />
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
  );
}

function ArtifactBody(props: { readonly content: ArtifactContent }) {
  const { content } = props;
  const kind = artifactPreviewKind(content);
  if (kind === "image") {
    return (
      <ThreadMarkdownImageView
        uri={artifactDataUrl(content)}
        sourceKey={content.path}
        unavailable={false}
        alt={content.path}
        format={artifactExtension(content.path) === "svg" ? "svg" : undefined}
        onPressPreview={() => {}}
      />
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
  if (kind === "html") return <ArtifactHtmlPreview html={content.content} path={content.path} />;
  return (
    <AppText className="font-mono text-sm text-foreground" selectable>
      {content.content}
    </AppText>
  );
}

export function ThreadArtifactScreen(props: ThreadArtifactParams) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const path = Array.isArray(props.route.params.path)
    ? props.route.params.path.join("/")
    : props.route.params.path;
  const project = useArtifactProject(props.route.params);
  const { selectedThreadProject } = useThreadSelection();
  const workspaceRoot =
    (selectedThreadProject as { readonly workspaceRoot?: string } | null)?.workspaceRoot ?? null;
  const { load, refreshing, refresh } = useServerRead<ArtifactContent>(
    project.projectId === null ? null : `${environmentId}:${project.projectId}:${path}`,
    () =>
      readArtifact({
        environmentId: project.environmentId,
        projectId: project.projectId!,
        path,
      }),
  );
  // One scroll view registered with the header, so iOS insets it under the transparent header
  // and the status bar like upstream's screens; the path row scrolls with the document.
  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-4 px-4 py-4"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      <NativeStackScreenOptions options={{ title: path.split("/").at(-1) ?? "Artifact" }} />
      <View className="flex-row items-center justify-between gap-3">
        <AppText textRole="label" className="min-w-0 shrink text-foreground-muted" selectable>
          artifacts/{path}
        </AppText>
        <Button
          label="All artifacts"
          tone="text"
          onPress={() => navigation.navigate("ThreadArtifacts", { environmentId, threadId })}
        />
      </View>
      {project.projectId === null ? (
        <EmptyState title="Artifact unavailable" detail="This thread has no project." />
      ) : load.status === "loading" ? (
        <AppText className="text-foreground-muted">Opening artifact…</AppText>
      ) : load.status === "error" ? (
        <EmptyState title="Couldn't open this artifact" detail={load.message} />
      ) : artifactPreviewKind(load.value) === "markdown" && workspaceRoot !== null ? (
        <WorkspaceMarkdown
          markdown={load.value.content}
          links={{ navigation, environmentId, threadId, workspaceRoot }}
        />
      ) : (
        <ArtifactBody content={load.value} />
      )}
    </ScreenScrollView>
  );
}

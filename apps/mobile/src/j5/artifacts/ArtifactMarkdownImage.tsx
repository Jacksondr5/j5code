import {
  artifactDataUrl,
  artifactExtension,
  artifactPreviewKind,
} from "@t3tools/client-runtime/j5/artifacts";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Platform } from "react-native";

import type { FilePreviewSource } from "../../components/FilePreviewModal";
import {
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "../../features/threads/ThreadMarkdownImage";
import { readArtifact } from "./artifactClient";
import { useServerRead } from "./serverRead";

/**
 * An `artifacts/…` image in Markdown, read from J5's artifact store as the artifact viewer reads
 * it: artifacts live in the server's state, not the workspace the other images resolve from.
 */
export function ArtifactMarkdownImage(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
  readonly alt: string | null;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const { environmentId, projectId, path } = props;
  const { load } = useServerRead(`${environmentId}:${projectId}:${path}`, () =>
    readArtifact({ environmentId, projectId, path }),
  );
  if (load.status === "ready" && artifactPreviewKind(load.value) !== "image") {
    return <ThreadMarkdownImageUnavailable alt={props.alt} />;
  }
  const svg = artifactExtension(path) === "svg";
  return (
    <ThreadMarkdownImageView
      uri={load.status === "ready" ? artifactDataUrl(load.value) : null}
      sourceKey={`artifact:${path}`}
      unavailable={load.status === "error"}
      alt={props.alt}
      format={svg ? "svg" : undefined}
      // Upstream's Android full-screen viewer can't draw SVG, as in the artifact viewer.
      onPressPreview={svg && Platform.OS === "android" ? () => undefined : props.onPressPreview}
    />
  );
}

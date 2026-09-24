import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ArtifactsPage } from "../j5/artifacts/ArtifactsPage";

export interface ArtifactsSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  /** Artifact path to open, relative to the project's artifacts directory. */
  readonly path?: string;
}

export const Route = createFileRoute("/artifacts")({
  validateSearch: (raw: Record<string, unknown>): ArtifactsSearch => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.path === "string" && raw.path ? { path: raw.path } : {}),
  }),
  component: ArtifactsRouteView,
});

function ArtifactsRouteView() {
  const search = Route.useSearch();
  return (
    <ArtifactsPage
      {...(search.environmentId === undefined
        ? {}
        : { initialEnvironmentId: search.environmentId })}
      {...(search.projectId === undefined ? {} : { initialProjectId: search.projectId })}
      {...(search.path === undefined ? {} : { initialPath: search.path })}
    />
  );
}

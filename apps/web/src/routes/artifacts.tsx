import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ArtifactsPage } from "../j5/artifacts/ArtifactsPage";

export interface ArtifactsSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
}

export const Route = createFileRoute("/artifacts")({
  validateSearch: (raw: Record<string, unknown>): ArtifactsSearch => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
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
    />
  );
}

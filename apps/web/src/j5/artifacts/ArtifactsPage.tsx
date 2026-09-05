import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ArtifactContent, ArtifactEntry } from "@t3tools/contracts";
import {
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FolderArchiveIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { artifactEnvironment } from "../../state/artifacts";
import { useEnvironmentQuery } from "../../state/query";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { listArtifacts, readArtifact } from "./artifactClient";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const extensionOf = (path: string) => path.split(".").at(-1)?.toLowerCase() ?? "";
const projectKey = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;

function artifactIcon(path: string) {
  const extension = extensionOf(path);
  if (MARKDOWN_EXTENSIONS.has(extension)) return FileTextIcon;
  if (IMAGE_MEDIA_TYPES[extension] !== undefined) return FileImageIcon;
  return FileIcon;
}

function binaryDataUrl(content: ArtifactContent) {
  const mediaType = IMAGE_MEDIA_TYPES[extensionOf(content.path)] ?? "application/octet-stream";
  if (content.encoding === "base64") return `data:${mediaType};base64,${content.content}`;
  return `data:${mediaType};charset=utf-8,${encodeURIComponent(content.content)}`;
}

export interface ArtifactsPageProps {
  readonly initialEnvironmentId?: string;
  readonly initialProjectId?: string;
}

export function ArtifactsPage({ initialEnvironmentId, initialProjectId }: ArtifactsPageProps) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const environmentLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const initialKey =
    initialEnvironmentId && initialProjectId ? `${initialEnvironmentId}:${initialProjectId}` : null;
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(() => initialKey);
  const [entries, setEntries] = useState<ReadonlyArray<ArtifactEntry>>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [listState, setListState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [contentState, setContentState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [listedProjectKey, setListedProjectKey] = useState<string | null>(null);

  const selectedProject = useMemo(
    () =>
      projects.find((project) => projectKey(project) === selectedProjectKey) ??
      projects.at(0) ??
      null,
    [projects, selectedProjectKey],
  );
  const selectedEnvironmentId = selectedProject?.environmentId ?? null;
  const selectedProjectId = selectedProject?.id ?? null;
  const selectedWorkspaceRoot = selectedProject?.workspaceRoot;
  const selectedKey = selectedProject === null ? null : projectKey(selectedProject);
  const artifactChange = useEnvironmentQuery(
    selectedEnvironmentId !== null && selectedProjectId !== null && listedProjectKey === selectedKey
      ? artifactEnvironment.changes({
          environmentId: selectedEnvironmentId,
          input: { projectId: selectedProjectId },
        })
      : null,
  );

  useEffect(() => {
    if (selectedProject !== null && selectedProjectKey !== projectKey(selectedProject)) {
      setSelectedProjectKey(projectKey(selectedProject));
    }
  }, [selectedProject, selectedProjectKey]);

  useEffect(() => {
    if (selectedEnvironmentId === null || selectedProjectId === null) {
      setEntries([]);
      setSelectedPath(null);
      setListedProjectKey(null);
      setListState("ready");
      return;
    }
    let current = true;
    setListState("loading");
    setError(null);
    void listArtifacts({
      environmentId: selectedEnvironmentId,
      projectId: selectedProjectId,
    }).then(
      (nextEntries) => {
        if (!current) return;
        setEntries(nextEntries);
        setSelectedPath((path) =>
          path !== null && nextEntries.some((entry) => entry.path === path)
            ? path
            : (nextEntries.at(0)?.path ?? null),
        );
        setListState("ready");
        setListedProjectKey(`${selectedEnvironmentId}:${selectedProjectId}`);
      },
      (cause: unknown) => {
        if (!current) return;
        setEntries([]);
        setSelectedPath(null);
        setError(cause instanceof Error ? cause.message : "Artifacts could not be loaded.");
        setListState("error");
      },
    );
    return () => {
      current = false;
    };
  }, [refreshGeneration, selectedEnvironmentId, selectedProjectId]);

  useEffect(() => {
    if (artifactChange.data === null || artifactChange.data.revision === 0) return;
    setRefreshGeneration((generation) => generation + 1);
  }, [artifactChange.data]);

  useEffect(() => {
    if (selectedEnvironmentId === null || selectedProjectId === null || selectedPath === null) {
      setContent(null);
      setContentState("idle");
      return;
    }
    let current = true;
    setContentState("loading");
    void readArtifact({
      environmentId: selectedEnvironmentId,
      projectId: selectedProjectId,
      path: selectedPath,
    }).then(
      (nextContent) => {
        if (!current) return;
        setContent(nextContent);
        setContentState("ready");
      },
      (cause: unknown) => {
        if (!current) return;
        setContent(null);
        setError(cause instanceof Error ? cause.message : "The artifact could not be opened.");
        setContentState("error");
      },
    );
    return () => {
      current = false;
    };
  }, [refreshGeneration, selectedEnvironmentId, selectedPath, selectedProjectId]);

  const refresh = useCallback(() => setRefreshGeneration((generation) => generation + 1), []);
  const selectedExtension = selectedPath === null ? "" : extensionOf(selectedPath);
  const image = IMAGE_MEDIA_TYPES[selectedExtension] !== undefined;
  const markdown = MARKDOWN_EXTENSIONS.has(selectedExtension);
  const html = selectedExtension === "html" || selectedExtension === "htm";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "flex shrink-0 items-center gap-3 px-3 sm:px-5",
            isElectron
              ? "drag-region h-[52px] wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
              : "h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)]",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <WorkspaceBreadcrumb ariaLabel="Artifacts breadcrumb">
            <WorkspaceBreadcrumbItem current>Artifacts</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <Button
            aria-label="Refresh artifacts"
            className="no-drag ms-auto"
            disabled={listState === "loading" || selectedProject === null}
            onClick={refresh}
            size="icon-xs"
            variant="ghost"
          >
            <RefreshCwIcon className={cn("size-3.5", listState === "loading" && "animate-spin")} />
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 border-t border-border md:grid-cols-[17rem_18rem_minmax(0,1fr)]">
          <ScrollArea className="min-h-0 border-b border-border md:border-e md:border-b-0">
            <div className="p-2">
              <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Workspaces</p>
              {projects.map((project) => {
                const selected =
                  selectedProject !== null && projectKey(project) === projectKey(selectedProject);
                return (
                  <button
                    key={projectKey(project)}
                    aria-pressed={selected}
                    className={cn(
                      "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                      selected && "bg-muted",
                    )}
                    onClick={() => {
                      setSelectedProjectKey(projectKey(project));
                      setSelectedPath(null);
                    }}
                    type="button"
                  >
                    <FolderArchiveIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate">{project.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {environmentLabels.get(project.environmentId) ?? "Environment"}
                      </span>
                    </span>
                  </button>
                );
              })}
              {projects.length === 0 ? (
                <p className="px-2 py-6 text-sm text-muted-foreground">No workspaces yet.</p>
              ) : null}
            </div>
          </ScrollArea>

          <ScrollArea className="min-h-0 border-b border-border md:border-e md:border-b-0">
            <div className="p-2">
              <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Files</p>
              {entries.map((entry) => {
                const Icon = artifactIcon(entry.path);
                return (
                  <button
                    key={entry.path}
                    aria-pressed={selectedPath === entry.path}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                      selectedPath === entry.path && "bg-muted",
                    )}
                    onClick={() => setSelectedPath(entry.path)}
                    type="button"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{entry.path}</span>
                  </button>
                );
              })}
              {listState === "ready" && entries.length === 0 && selectedProject !== null ? (
                <p className="px-2 py-6 text-sm text-muted-foreground">
                  Planning documents created in <code>artifacts/</code> will appear here.
                </p>
              ) : null}
              {listState === "error" ? (
                <div className="px-2 py-6 text-sm">
                  <p className="text-destructive">{error}</p>
                  <Button className="mt-3" onClick={refresh} size="sm" variant="outline">
                    Try again
                  </Button>
                </div>
              ) : null}
            </div>
          </ScrollArea>

          <ScrollArea className="min-h-0">
            <div className="min-h-full p-5 md:p-8">
              {contentState === "loading" ? (
                <p className="text-sm text-muted-foreground">Opening artifact…</p>
              ) : contentState === "error" ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : content === null ? (
                <div className="flex min-h-72 flex-col items-center justify-center text-center text-muted-foreground">
                  <FolderArchiveIcon className="mb-3 size-8" />
                  <p className="text-sm">Select an artifact to preview it.</p>
                </div>
              ) : image ? (
                <img
                  alt={content.path}
                  className="mx-auto max-h-[calc(100dvh-8rem)] max-w-full rounded-md border border-border object-contain"
                  src={binaryDataUrl(content)}
                />
              ) : html && content.encoding === "utf8" ? (
                <iframe
                  className="h-[calc(100dvh-8rem)] min-h-96 w-full border-0 bg-transparent"
                  referrerPolicy="no-referrer"
                  sandbox=""
                  srcDoc={content.content}
                  title={`Artifact preview: ${content.path}`}
                />
              ) : markdown && content.encoding === "utf8" ? (
                <ChatMarkdown
                  className="mx-auto max-w-4xl"
                  cwd={selectedWorkspaceRoot}
                  text={content.content}
                />
              ) : content.encoding === "utf8" ? (
                <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-sm">
                  {content.content}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Binary preview is not available for this artifact.
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </SidebarInset>
  );
}

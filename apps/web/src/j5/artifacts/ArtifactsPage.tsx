import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ArtifactContent, ArtifactEntry } from "@t3tools/contracts";
import {
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FolderArchiveIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import * as Option from "effect/Option";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { type ResizableWidthHandlers, useResizableWidth } from "../../hooks/useResizableWidth";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { artifactEnvironment } from "./artifactChanges";
import { listArtifacts, readArtifact, trashArtifact } from "./artifactClient";
import { artifactPreviewRevision } from "./artifactPreview.logic";
import { nextArtifactRefreshGeneration } from "./artifactRefresh";
import { artifactSelectionAfterTrash } from "./artifactTrash.logic";

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

const ARTIFACT_FILE_PANE_MIN_WIDTH = 144;
const ARTIFACT_FILE_PANE_MAX_WIDTH = 480;

function ArtifactFilePaneResizeHandle(props: {
  readonly embedded: boolean;
  readonly handlers: ResizableWidthHandlers;
  readonly width: number;
}) {
  return (
    <div
      aria-label="Resize artifact file list"
      aria-orientation="vertical"
      aria-valuemax={ARTIFACT_FILE_PANE_MAX_WIDTH}
      aria-valuemin={ARTIFACT_FILE_PANE_MIN_WIDTH}
      aria-valuenow={props.width}
      className={cn(
        "group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize select-none",
        !props.embedded && "hidden md:block",
      )}
      role="separator"
      {...props.handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
      />
    </div>
  );
}

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
  readonly initialPath?: string;
  readonly embedded?: boolean;
}

export function ArtifactsPage({
  initialEnvironmentId,
  initialProjectId,
  initialPath,
  embedded = false,
}: ArtifactsPageProps) {
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
  const [selectedPath, setSelectedPath] = useState<string | null>(() => initialPath ?? null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [listState, setListState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [contentState, setContentState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  // Two counters on purpose: the change stream bumps the list only; the Refresh button bumps
  // both. Only the second reaches the body read, so another file changing never re-reads this one.
  const [listGeneration, setListGeneration] = useState(0);
  const [manualRefreshes, setManualRefreshes] = useState(0);
  const [listedProjectKey, setListedProjectKey] = useState<string | null>(null);
  const [trashing, setTrashing] = useState(false);
  const filePane = useResizableWidth({
    storageKey: embedded ? "j5:artifacts:embedded-file-pane-width" : "j5:artifacts:file-pane-width",
    defaultWidth: embedded ? 208 : 288,
    minWidth: ARTIFACT_FILE_PANE_MIN_WIDTH,
    maxWidth: ARTIFACT_FILE_PANE_MAX_WIDTH,
    edge: "right",
  });

  const selectedProject = useMemo(
    () =>
      projects.find((project) => projectKey(project) === selectedProjectKey) ??
      (embedded ? null : (projects.at(0) ?? null)),
    [embedded, projects, selectedProjectKey],
  );
  const selectedEnvironmentId = selectedProject?.environmentId ?? null;
  const selectedProjectId = selectedProject?.id ?? null;
  const selectedWorkspaceRoot = selectedProject?.workspaceRoot;
  const selectedKey = selectedProject === null ? null : projectKey(selectedProject);
  // The artifact client reads the environment's prepared connection from an atom that only holds
  // a value while something subscribes to it. Inside a thread the chat surface keeps it mounted;
  // on the standalone route this page is the only subscriber, so it must hold the subscription
  // itself and wait for the connection before fetching, or every read fails as "not connected".
  const connected = Option.isSome(usePreparedConnection(selectedEnvironmentId));
  const selectedEntry = entries.find((entry) => entry.path === selectedPath);
  const selectedRevision = artifactPreviewRevision(selectedEntry, manualRefreshes);
  const artifactChange = useEnvironmentQuery(
    selectedEnvironmentId !== null && selectedProjectId !== null && listedProjectKey === selectedKey
      ? artifactEnvironment.changes({
          environmentId: selectedEnvironmentId,
          input: { projectId: selectedProjectId },
        })
      : null,
  );

  useEffect(() => {
    if (embedded) return;
    if (selectedProject !== null && selectedProjectKey !== projectKey(selectedProject)) {
      setSelectedProjectKey(projectKey(selectedProject));
    }
  }, [embedded, selectedProject, selectedProjectKey]);

  useEffect(() => {
    if (selectedEnvironmentId === null || selectedProjectId === null) {
      setEntries([]);
      setSelectedPath(null);
      setListedProjectKey(null);
      setListState("ready");
      return;
    }
    if (!connected) {
      setListState("loading");
      setError(null);
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
  }, [connected, listGeneration, manualRefreshes, selectedEnvironmentId, selectedProjectId]);

  useEffect(() => {
    setListGeneration((generation) =>
      nextArtifactRefreshGeneration(generation, artifactChange.data),
    );
  }, [artifactChange.data]);

  useEffect(() => {
    if (
      !connected ||
      selectedEnvironmentId === null ||
      selectedProjectId === null ||
      selectedPath === null
    ) {
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
  }, [connected, selectedEnvironmentId, selectedPath, selectedProjectId, selectedRevision]);

  const refresh = useCallback(() => setManualRefreshes((count) => count + 1), []);
  const trashSelectedArtifact = useCallback(async () => {
    if (
      selectedEnvironmentId === null ||
      selectedProjectId === null ||
      selectedPath === null ||
      trashing
    ) {
      return;
    }
    const path = selectedPath;
    const confirmation = requestConfirmDialog(
      `Move “${path}” to the Trash on the environment host? You can recover it from that host account's Trash or Recycle Bin.`,
      { variant: "destructive" },
      { confirmLabel: "Move to Trash" },
    );
    if (confirmation === undefined || !(await confirmation)) return;

    setTrashing(true);
    setError(null);
    try {
      await trashArtifact({
        environmentId: selectedEnvironmentId,
        projectId: selectedProjectId,
        path,
      });
      const next = artifactSelectionAfterTrash(entries, path);
      setEntries(next.entries);
      setSelectedPath((current) => (current === path ? next.selectedPath : current));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The artifact could not be moved to Trash.",
      );
      setContentState("error");
    } finally {
      setTrashing(false);
    }
  }, [entries, selectedEnvironmentId, selectedPath, selectedProjectId, trashing]);
  const selectedExtension = selectedPath === null ? "" : extensionOf(selectedPath);
  const image = IMAGE_MEDIA_TYPES[selectedExtension] !== undefined;
  const markdown = MARKDOWN_EXTENSIONS.has(selectedExtension);
  const html = selectedExtension === "html" || selectedExtension === "htm";

  return (
    <SidebarInset
      className={cn(
        "min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate",
        embedded ? "h-full" : "h-dvh",
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!embedded ? (
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
              <RefreshCwIcon
                className={cn("size-3.5", listState === "loading" && "animate-spin")}
              />
            </Button>
          </header>
        ) : null}

        <div
          className={cn(
            "grid min-h-0 flex-1 border-t border-border",
            embedded
              ? "grid-cols-[var(--artifact-file-pane-width)_minmax(0,1fr)]"
              : "grid-cols-1 md:grid-cols-[17rem_var(--artifact-file-pane-width)_minmax(0,1fr)]",
          )}
          style={{ "--artifact-file-pane-width": `${filePane.width}px` } as CSSProperties}
        >
          {!embedded ? (
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
          ) : null}

          <div
            className={cn(
              "relative min-h-0 border-border",
              embedded ? "border-e" : "border-b md:border-e md:border-b-0",
            )}
          >
            <ScrollArea className="min-h-0">
              <div className="p-2">
                <div className="flex items-center px-2 py-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Files</p>
                  <Button
                    aria-label="Move artifact to Trash"
                    className="ms-auto"
                    disabled={selectedPath === null || trashing}
                    onClick={() => void trashSelectedArtifact()}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                  {embedded ? (
                    <Button
                      aria-label="Refresh artifacts"
                      disabled={listState === "loading" || selectedProject === null}
                      onClick={refresh}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <RefreshCwIcon
                        className={cn("size-3.5", listState === "loading" && "animate-spin")}
                      />
                    </Button>
                  ) : null}
                </div>
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
                {listState === "loading" && !connected && selectedProject !== null ? (
                  <p className="px-2 py-6 text-sm text-muted-foreground">
                    Connecting to the environment…
                  </p>
                ) : null}
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
            <ArtifactFilePaneResizeHandle
              embedded={embedded}
              handlers={filePane.handlers}
              width={filePane.width}
            />
          </div>

          <ScrollArea className="min-h-0">
            <div className={cn("min-h-full", embedded ? "p-4" : "p-5 md:p-8")}>
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

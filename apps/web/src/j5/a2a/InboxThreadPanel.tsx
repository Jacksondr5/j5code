import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import {
  AuthPreviewOperateScope,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useEffect, useEffectEvent, useState } from "react";

import { ChatRightPanel } from "../../components/chat/ChatRightPanel";
import {
  PanelLayoutControls,
  RightPanelMaximizeControl,
} from "../../components/chat/PanelLayoutControls";
import { RightPanelSurfaceContent } from "../../components/chat/RightPanelSurfaceContent";
import { usePreviewSession } from "../../components/preview/usePreviewSession";
import { Button } from "../../components/ui/button";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useRightPanelSurfaceClose } from "../../hooks/useRightPanelSurfaceClose";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { cn } from "../../lib/utils";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import { useThreadPreviewState } from "../../previewStateStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import {
  type RightPanelSurface,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentSupportsServerBrowser, useProject } from "../../state/entities";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  followInboxThreadPanelOpens,
  type InboxPanelThread,
  useInboxThreadPanelStore,
} from "./inboxThreadPanel";
import { useSenderThread } from "./useSenderThread";

const PreviewPanel = lazy(() =>
  import("../../components/preview/PreviewPanel").then((module) => ({
    default: module.PreviewPanel,
  })),
);
const DiffPanel = lazy(() => import("../../components/DiffPanel"));

const EMPTY_PENDING: ReadonlySet<string> = new Set();
const EMPTY_TERMINAL_LABELS: ReadonlyMap<string, string> = new Map();
const NOOP = () => undefined;

/**
 * The Inbox beside the asking thread's own right panel. The panel is the thread's: its tabs and
 * whether it is open live in the thread's right panel state, so what is opened or closed here is
 * so in the thread too. Only the Inbox's own layout (which thread, maximized) is kept here.
 */
export function InboxWithThreadPanel({ children }: { readonly children: ReactNode }) {
  const shown = useInboxThreadPanelStore((state) => state.shown);
  const ref = shown?.ref ?? null;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const panelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, ref),
  );
  const activeSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, ref),
  );
  const open = ref !== null && panelState.isOpen;
  const [maximizedChoice, setMaximized] = useState(false);
  const maximized = open && maximizedChoice;
  const prefersSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const sheet = prefersSheet && !maximized;
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const { active: animationsActive, durationMs } = usePanelAnimationSettings();
  const presence = usePanelPresence(
    open,
    shown === null ? null : { thread: shown, activeSurface, surfaces: panelState.surfaces },
    animationsActive,
    ref === null ? null : scopedThreadKey(ref),
    durationMs,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the right panel store so a link opened from an ask shows its thread's panel
  useEffect(() => followInboxThreadPanelOpens(), []);

  const toggle = () => {
    if (ref === null) return;
    if (open) useRightPanelStore.getState().close(ref);
    else useRightPanelStore.getState().show(ref);
  };
  const toggleMaximized = () => {
    if (open) setMaximized((value) => !value);
  };
  const closeSheet = () => {
    if (ref !== null) useRightPanelStore.getState().close(ref);
  };
  const surfaceClose = useRightPanelSurfaceClose({
    threadRef: ref,
    terminalLabelsById: EMPTY_TERMINAL_LABELS,
  });
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || isCommandPaletteOpen()) return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: isPreviewFocused(),
        previewOpen: open && activeSurface?.kind === "preview",
        editableFocus: isEditableFocused(event.target),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    });
    if (command === "rightPanel.toggle" && ref !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggle();
    }
    if (command === "rightPanel.toggleMaximized" && open) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleMaximized();
    }
    if (command === "rightPanel.close" && open && activeSurface !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) surfaceClose.closeSurface(activeSurface);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document keydown listener for the right panel shortcuts, as on the Pull requests page
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const toggleControl = (
    <PanelLayoutControls
      showTerminalControl={false}
      showThreadPanelControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      threadPanelOpen={false}
      threadPanelPresentation="inline"
      threadPanelShortcutLabel={null}
      onToggleThreadPanel={NOOP}
      onToggleTerminal={NOOP}
      rightPanelAvailable={ref !== null}
      rightPanelOpen={open}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      rightPanelUnavailableLabel="Open a link in an ask first"
      onToggleRightPanel={toggle}
    />
  );
  const rootControls = (
    <div
      className="absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      {open && !sheet ? (
        <RightPanelMaximizeControl maximized={maximized} onToggle={toggleMaximized} />
      ) : null}
      {toggleControl}
    </div>
  );
  const rendered = presence.value;

  return (
    <div className="relative flex min-h-0 flex-1" ref={setRow}>
      {rootControls}
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", maximized && "hidden")}>
        {children}
      </div>
      {presence.present && rendered !== null ? (
        <InboxThreadPanel
          key={scopedThreadKey(rendered.thread.ref)}
          thread={rendered.thread}
          activeSurface={rendered.activeSurface}
          surfaces={rendered.surfaces}
          open={open}
          sheet={sheet}
          maximized={maximized}
          row={row}
          sheetAnimationDurationMs={animationsActive ? durationMs : 0}
          keybindings={keybindings}
          sheetControls={toggleControl}
          onCloseSheet={closeSheet}
          surfaceClose={surfaceClose}
        />
      ) : null}
    </div>
  );
}

function InboxThreadPanel(props: {
  readonly thread: InboxPanelThread;
  readonly activeSurface: RightPanelSurface | null;
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
  readonly open: boolean;
  readonly sheet: boolean;
  readonly maximized: boolean;
  readonly row: HTMLElement | null;
  readonly sheetAnimationDurationMs: number;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly sheetControls: ReactNode;
  readonly onCloseSheet: () => void;
  readonly surfaceClose: ReturnType<typeof useRightPanelSurfaceClose>;
}) {
  const { thread, activeSurface, open, keybindings } = props;
  const ref = thread.ref;
  const sender = useSenderThread(ref);
  const project = useProject(
    sender.projectId === null
      ? null
      : { environmentId: ref.environmentId, projectId: sender.projectId },
  );
  const workspaceRoot = sender.worktreePath ?? project?.workspaceRoot ?? undefined;
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(ref.environmentId));
  const canOperatePreview = useEnvironmentScope(ref.environmentId, AuthPreviewOperateScope);
  const serverBrowser = useEnvironmentSupportsServerBrowser(ref.environmentId);
  const previewState = useThreadPreviewState(ref);
  const [pendingFiles, setPendingFiles] = useState<ReadonlySet<string>>(EMPTY_PENDING);
  const { closeSurface, closeOtherSurfaces, closeSurfacesToRight, closeAllSurfaces } =
    props.surfaceClose;
  const navigate = useNavigate();
  const openThread = () =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  const visible = open;

  const content = (() => {
    const surface = activeSurface;
    if (surface === null) return null;
    switch (surface.kind) {
      // Pick element sends a turn to the thread; an ask is answered from its reply box instead.
      case "preview":
        return (
          <Suspense fallback={null}>
            <PreviewPanel
              mode="embedded"
              threadRef={ref}
              tabId={surface.resourceId}
              configuredUrls={[]}
              visible={visible}
            />
          </Suspense>
        );
      case "diff":
        return (
          <Suspense fallback={null}>
            <DiffPanel
              key={scopedThreadKey(ref)}
              mode="embedded"
              threadRef={ref}
              composerDraftTarget={ref}
              workspaceMutationId={null}
              visible={visible}
            />
          </Suspense>
        );
      // The terminal and side chats are not mirrored in the Inbox; their tabs stay the thread's.
      case "terminal":
      case "side-chat":
        return (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              {surface.kind === "terminal"
                ? "The terminal opens in the agent's thread."
                : "Side chats open in the agent's thread."}
            </p>
            <Button onClick={openThread} size="sm" type="button" variant="outline">
              Open thread
            </Button>
          </div>
        );
      default:
        return (
          <RightPanelSurfaceContent
            surface={surface}
            activeSurfaceId={surface.id}
            threadRef={ref}
            environmentId={ref.environmentId}
            visible={visible}
            composerDraftTarget={ref}
            keybindings={keybindings}
            configuredPreviewUrls={[]}
            workspaceMutationId={null}
            artifactsProjectId={sender.projectId}
            getShortcutContext={shortcutContext}
            onSendAnnotation={NOOP}
            onCloseSurface={closeSurface}
            sideChatParentPanel={{ openToolDiff: NOOP, runShellCommand: NOOP }}
            terminal={{
              launchContext: null,
              keybindings,
              onAddTerminalContext: NOOP,
              onSplitTerminal: NOOP,
              onSplitTerminalVertical: NOOP,
              onNewTerminal: NOOP,
              onActiveTerminalChange: NOOP,
              onCloseTerminal: NOOP,
            }}
            pullRequest={{
              capabilityKnown: serverConfig !== null,
              supported: serverConfig !== null,
              projectId: sender.projectId,
              pullRequests: visibleThreadPullRequests(sender.pullRequests),
              linkedPullRequest: sender.linkedPullRequest,
              branchPullRequest: sender.branchPullRequest,
              onBack: undefined,
            }}
            files={{
              projectName: project?.title ?? null,
              workspaceRoot,
              availableEditors,
              pendingSurfaceIds: pendingFiles,
              onOpenFile: (relativePath) =>
                useRightPanelStore.getState().openFile(ref, relativePath),
              onPendingChange: (relativePath, pending) =>
                setPendingFiles((current) => {
                  const id = `file:${relativePath}`;
                  if (current.has(id) === pending) return current;
                  const next = new Set(current);
                  if (pending) next.add(id);
                  else next.delete(id);
                  return next;
                }),
            }}
          />
        );
    }
  })();

  return (
    <>
      {canOperatePreview && serverBrowser ? <PreviewSessionSync threadRef={ref} /> : null}
      <ChatRightPanel
        sheet={props.sheet}
        workspaceLayoutElement={props.row}
        widthStorageKey="t3code:inbox-thread-panel-width"
        sheetAnimationDurationMs={props.sheetAnimationDurationMs}
        onCloseSheet={props.onCloseSheet}
        open={open}
        keybindings={keybindings}
        getShortcutContext={shortcutContext}
        maximized={props.maximized}
        layoutControls={open ? props.sheetControls : null}
        surfaces={[...props.surfaces]}
        environmentId={ref.environmentId}
        activeSurfaceId={activeSurface?.id ?? null}
        pendingSurfaceIds={pendingFiles}
        previewSessions={previewState.sessions}
        desktopByTabId={previewState.desktopByTabId}
        previewRuntimeTabId={(tabId) => previewRuntimeTabId(ref, previewState.serverEpoch, tabId)}
        terminalLabelsById={EMPTY_TERMINAL_LABELS}
        onActivate={(surface) => useRightPanelStore.getState().activateSurface(ref, surface.id)}
        onCloseSurface={closeSurface}
        onCloseOtherSurfaces={closeOtherSurfaces}
        onCloseSurfacesToRight={closeSurfacesToRight}
        onCloseAllSurfaces={closeAllSurfaces}
        onMoveSurface={(surfaceId, toIndex) =>
          useRightPanelStore.getState().moveSurface(ref, surfaceId, toIndex)
        }
        onCopyFilePath={NOOP}
        onAddBrowser={NOOP}
        onAddBrowserInProfile={NOOP}
        onAddTerminal={NOOP}
        onAddDiff={NOOP}
        onAddFiles={NOOP}
        onAddArtifacts={NOOP}
        onAddPullRequest={NOOP}
        onAddPullRequests={NOOP}
        onAddDevice={NOOP}
        browserAvailable={false}
        terminalAvailable={false}
        diffAvailable={false}
        filesAvailable={false}
        artifactsAvailable={false}
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        deviceAvailable={false}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <InboxThreadPanelHeader agentLabel={thread.agentLabel} threadTitle={sender.title} />
          <div className="flex min-h-0 flex-1 flex-col">{content}</div>
        </div>
      </ChatRightPanel>
    </>
  );
}

function shortcutContext() {
  return {
    terminalFocus: false,
    terminalOpen: false,
    previewFocus: isPreviewFocused(),
    previewOpen: false,
    editableFocus: isEditableFocused(document.activeElement),
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

function InboxThreadPanelHeader(props: {
  readonly agentLabel: string;
  readonly threadTitle: string | null;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
      <span className="truncate font-medium text-foreground/80">{props.agentLabel}</span>
      {props.threadTitle === null ? null : (
        <>
          <span aria-hidden>·</span>
          <span className="truncate">{props.threadTitle}</span>
        </>
      )}
    </div>
  );
}

function PreviewSessionSync(props: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(props.threadRef);
  return null;
}

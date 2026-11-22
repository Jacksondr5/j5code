import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthPreviewOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { Globe2Icon, XIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { reportMarkdownActionFailure } from "../../components/chat/markdownActionFailure";
import { addBrowserSurface } from "../../components/preview/addBrowserSurface";
import { RightPanelTabs } from "../../components/RightPanelTabs";
import { Button } from "../../components/ui/button";
import { BrowserSettingsReadError, openUrlInPreview } from "../../browser/openFileInPreview";
import { isPreviewAvailableFor, usePreviewAvailable } from "../../browser/previewRuntime";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useClientSettings } from "../../hooks/useSettings";
import { useRightPanelSurfaceClose } from "../../hooks/useRightPanelSurfaceClose";
import { readLocalApi } from "../../localApi";
import { setActivePreviewTab, useThreadPreviewState } from "../../previewStateStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { previewEnvironment } from "../../state/preview";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { useConnectionAccess } from "../sharing/access";
import { inboxBrowserRef, opensInInboxBrowser, useInboxBrowserStore } from "./inboxBrowser";

const PreviewPanel = lazy(() =>
  import("../../components/preview/PreviewPanel").then((module) => ({
    default: module.PreviewPanel,
  })),
);

const NO_PENDING_SURFACES = new Set<string>();
const NO_TERMINAL_LABELS = new Map<string, string>();
const noop = () => undefined;

function getShortcutContext() {
  return {
    terminalFocus: false,
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

/**
 * Takes a click on a web link in an ask from `environmentId` when it should open in that server's
 * Inbox browser, as `ChatMarkdown`'s `onOpenWebLink`.
 */
export function useOpenInInboxBrowser(environmentId: EnvironmentId) {
  // Subscribed so a saved "app" applies once settings hydrate.
  const preference = useClientSettings((settings) => settings.browserLinkTarget);
  const access = useConnectionAccess(environmentId);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return (url: string, event: { readonly metaKey: boolean; readonly ctrlKey: boolean }) => {
    if (
      !opensInInboxBrowser({
        url,
        event,
        preference,
        previewAvailable: isPreviewAvailableFor(environmentId),
        canOperatePreview: readEnvironmentScope(environmentId, AuthPreviewOperateScope),
        access,
        sheetLayout: window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches,
      })
    )
      return false;
    void openUrlInPreview({ threadRef: inboxBrowserRef(environmentId), url, openPreview }).then(
      (result) => {
        if (result._tag === "Success") {
          useInboxBrowserStore.setState({ environmentId });
          return;
        }
        if (isAtomCommandInterrupted(result)) return;
        reportMarkdownActionFailure(
          { operation: "open-link-in-preview", target: url },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        if (error instanceof BrowserSettingsReadError) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open link in browser",
              description: error.message,
            }),
          );
          return;
        }
        void readLocalApi()?.shell.openExternal(url);
      },
    );
    return true;
  };
}

/** The server whose Inbox browser the page shows; none where a thread's panel would be a sheet. */
function useShownInboxBrowser() {
  const sheetLayout = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const storedEnvironmentId = useInboxBrowserStore((state) => state.environmentId);
  const environmentId = sheetLayout ? null : storedEnvironmentId;
  const ref = environmentId === null ? null : inboxBrowserRef(environmentId);
  const panel = useRightPanelStore((state) => selectThreadRightPanelState(state.byThreadKey, ref));
  return { environmentId, panel };
}

/** Whether the Inbox browser is beside the asks, so the page header leaves the title bar to it. */
export function useInboxBrowserShown(): boolean {
  const { environmentId, panel } = useShownInboxBrowser();
  return environmentId !== null && panel.isOpen && panel.surfaces.length > 0;
}

/** Brings back an Inbox browser that was closed with tabs still open. */
export function InboxBrowserShowButton() {
  const { environmentId, panel } = useShownInboxBrowser();
  if (environmentId === null || panel.isOpen || panel.surfaces.length === 0) return null;
  return (
    <Button
      onClick={() => useRightPanelStore.getState().show(inboxBrowserRef(environmentId))}
      size="sm"
      type="button"
      variant="ghost"
    >
      <Globe2Icon aria-hidden className="size-4" />
      Browser
    </Button>
  );
}

/** The Inbox's browser for the server a link was last opened on, beside the asks. */
export function InboxBrowserPane() {
  const { environmentId } = useShownInboxBrowser();
  if (environmentId === null) return null;
  return <InboxBrowserPanel environmentId={environmentId} key={environmentId} />;
}

function InboxBrowserPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const ref = inboxBrowserRef(environmentId);
  const panel = useRightPanelStore((state) => selectThreadRightPanelState(state.byThreadKey, ref));
  const previewState = useThreadPreviewState(ref);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const previewAvailable = usePreviewAvailable(environmentId);
  const { closeSurface, closeOtherSurfaces, closeSurfacesToRight, closeAllSurfaces } =
    useRightPanelSurfaceClose({ threadRef: ref, terminalLabelsById: NO_TERMINAL_LABELS });
  if (!panel.isOpen || panel.surfaces.length === 0) return null;
  const activeSurface =
    panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null;
  const addBrowser = (profileId?: string) =>
    void addBrowserSurface({
      threadRef: ref,
      openPreview,
      ...(profileId === undefined ? {} : { profileId }),
    });
  return (
    <RightPanelTabs
      mode="inline"
      keybindings={keybindings}
      getShortcutContext={getShortcutContext}
      widthStorageKey="j5:inbox-browser-width"
      defaultWidth={typeof window === "undefined" ? 640 : Math.floor(window.innerWidth / 2)}
      layoutControls={
        <Button
          aria-label="Close browser"
          onClick={() => useRightPanelStore.getState().close(ref)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      }
      surfaces={panel.surfaces}
      environmentId={environmentId}
      activeSurfaceId={activeSurface?.id ?? null}
      pendingSurfaceIds={NO_PENDING_SURFACES}
      previewSessions={previewState.sessions}
      desktopByTabId={previewState.desktopByTabId}
      previewRuntimeTabId={(tabId) => previewRuntimeTabId(ref, previewState.serverEpoch, tabId)}
      terminalLabelsById={NO_TERMINAL_LABELS}
      onActivate={(surface) => {
        useRightPanelStore.getState().activateSurface(ref, surface.id);
        if (surface.kind === "preview" && surface.resourceId)
          setActivePreviewTab(ref, surface.resourceId);
      }}
      onCloseSurface={closeSurface}
      onCloseOtherSurfaces={closeOtherSurfaces}
      onCloseSurfacesToRight={closeSurfacesToRight}
      onCloseAllSurfaces={closeAllSurfaces}
      onMoveSurface={(surfaceId, toIndex) =>
        useRightPanelStore.getState().moveSurface(ref, surfaceId, toIndex)
      }
      onCopyFilePath={noop}
      onAddBrowser={() => addBrowser()}
      onAddBrowserInProfile={addBrowser}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddArtifacts={noop}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDevice={noop}
      browserAvailable={canOperatePreview && previewAvailable}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      artifactsAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
    >
      {activeSurface?.kind === "preview" ? (
        <Suspense fallback={null}>
          <PreviewPanel mode="embedded" threadRef={ref} tabId={activeSurface.resourceId} visible />
        </Suspense>
      ) : null}
    </RightPanelTabs>
  );
}

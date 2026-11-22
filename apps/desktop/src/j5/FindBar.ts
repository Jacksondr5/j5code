import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import type { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { FIND_BAR_HTML } from "./findBarPage.ts";
import {
  FIND_BAR_COMMAND_CHANNEL,
  FIND_BAR_FOCUS_CHANNEL,
  FIND_BAR_MATCHES_CHANNEL,
  type FindBarCommand,
} from "./findBarProtocol.ts";
import { makeFindController, type FindArea, type FindController } from "./findController.ts";

const controllers = new WeakMap<Electron.WebContents, FindController>();

// Duplicates the markers in apps/web/src/j5/artifacts/artifactFind.ts.
const FOCUSED_ARTIFACT_AREA_SCRIPT = `(() => {
  const surface = document.activeElement?.closest("[data-j5-artifacts-surface]");
  if (!surface) return null;
  const rect = (surface.querySelector("[data-j5-artifact-find-area]") ?? surface).getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
})()`;
// The focused element when the bar opened: inside the artifact, or its iframe.
const REMEMBER_FOCUS_SCRIPT = "window.__j5FindBarReturnFocus = document.activeElement; 0";
const RESTORE_FOCUS_SCRIPT =
  "window.__j5FindBarReturnFocus?.focus({ preventScroll: true }); window.__j5FindBarReturnFocus = null; 0";

const FindAreaSchema = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
const isFindArea = Schema.is(FindAreaSchema);

function isFindShortcut(input: Electron.Input, platform: string): boolean {
  if (input.type !== "keyDown" || input.alt || input.shift || input.key.toLowerCase() !== "f") {
    return false;
  }
  return platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
}

/**
 * Gives a main window J5's find bar: a page in its own view laid over the window, so
 * `findInPage` leaves the bar's field focused and its own text out of the count.
 */
export function installFindBar(
  window: Electron.BrowserWindow,
  environment: Pick<DesktopEnvironment["Service"], "path" | "dirname" | "platform">,
): void {
  const preload = environment.path.join(environment.dirname, "j5-find-bar-preload.cjs");
  const contents = window.webContents;
  const runInPage = (script: string) => void contents.executeJavaScript(script).catch(() => {});
  let view: Electron.WebContentsView | null = null;
  let loaded: Promise<void> = Promise.resolve();
  const whenLoaded = (run: (bar: Electron.WebContents) => void) => {
    const bar = view?.webContents;
    if (bar) void loaded.then(() => !bar.isDestroyed() && run(bar));
  };
  const ensureView = () => {
    if (view !== null) return view;
    view = new Electron.WebContentsView({
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    view.setBackgroundColor("#00000000");
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    view.webContents.ipc.on(FIND_BAR_COMMAND_CHANNEL, (_event, command: FindBarCommand) => {
      if (command.type === "query") controller.query(String(command.text));
      else if (command.type === "next") controller.next();
      else if (command.type === "previous") controller.previous();
      else if (command.type === "close") controller.close();
    });
    loaded = view.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(FIND_BAR_HTML)}`)
      .catch(() => undefined);
    return view;
  };

  const controller = makeFindController(
    {
      findInPage: (text, findOptions) => contents.findInPage(text, findOptions),
      stopFindInPage: () => contents.stopFindInPage("clearSelection"),
      rememberFocus: () => runInPage(REMEMBER_FOCUS_SCRIPT),
      restoreFocus: () => {
        contents.focus();
        runInPage(RESTORE_FOCUS_SCRIPT);
      },
      zoomFactor: () => contents.getZoomFactor(),
      contentSize: () => {
        const [width = 0, height = 0] = window.getContentSize();
        return { width, height };
      },
    },
    {
      show: (bounds) => {
        const bar = ensureView();
        // Adding again also raises it above views added since.
        window.contentView.addChildView(bar);
        bar.setBounds(bounds);
      },
      hide: () => {
        if (view !== null) window.contentView.removeChildView(view);
      },
      focus: () =>
        whenLoaded((bar) => {
          bar.focus();
          bar.send(FIND_BAR_FOCUS_CHANNEL);
        }),
      matches: (matches) => whenLoaded((bar) => bar.send(FIND_BAR_MATCHES_CHANNEL, matches)),
    },
  );
  controllers.set(contents, controller);

  contents.on("found-in-page", (_event, result) => controller.found(result));
  contents.on("did-navigate", () => controller.close());
  window.on("resize", () => controller.relayout());
  // An iframe's keys never reach the page, whose own handler opens the bar for the main frame.
  contents.on("before-input-event", (event, input) => {
    if (!isFindShortcut(input, environment.platform) || !contents.focusedFrame?.parent) return;
    event.preventDefault();
    contents
      .executeJavaScript(FOCUSED_ARTIFACT_AREA_SCRIPT)
      .then((area: unknown) => {
        if (isFindArea(area)) controller.open(area);
      })
      .catch(() => undefined);
  });
  window.once("closed", () => {
    if (view !== null && !view.webContents.isDestroyed()) view.webContents.close();
  });
}

export const openFindBar = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_FIND_BAR_CHANNEL,
  payload: FindAreaSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.j5.openFindBar")(function* (area: FindArea, event) {
    if (event === undefined) return;
    const sender = Electron.webContents.fromId(event.sender.id);
    const controller = sender === undefined ? undefined : controllers.get(sender);
    if (controller !== undefined) yield* Effect.sync(() => controller.open(area));
  }),
});

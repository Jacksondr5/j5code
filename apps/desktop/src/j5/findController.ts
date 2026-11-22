import type { FindMatches } from "./findBarProtocol.ts";

/** A rect in the page's CSS pixels. */
export interface FindArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FindBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The main window's page, which Chromium's find-in-page searches as a whole, iframes included. */
export interface FindTarget {
  /** Electron's `findNext: true` starts a new session; `false` steps to the next match. */
  readonly findInPage: (text: string, options: { findNext: boolean; forward: boolean }) => number;
  readonly stopFindInPage: () => void;
  /** Find moves the page's focus to the active match, which can be outside the artifact. */
  readonly rememberFocus: () => void;
  readonly restoreFocus: () => void;
  readonly zoomFactor: () => number;
  /** The window's content size in DIPs, the space child views are placed in. */
  readonly contentSize: () => { readonly width: number; readonly height: number };
}

export interface FindBarView {
  /** Adds the bar above the page's other views. */
  readonly show: (bounds: FindBounds) => void;
  /** Only moves it: re-adding the view can drop its focus on macOS. */
  readonly place: (bounds: FindBounds) => void;
  readonly hide: () => void;
  /** Focuses the field with `query` in it, selected. */
  readonly focus: (query: string) => void;
  readonly matches: (matches: FindMatches | null) => void;
}

export interface FoundInPage {
  readonly requestId: number;
  readonly activeMatchOrdinal: number;
  readonly matches: number;
}

export const FIND_BAR_WIDTH = 320;
export const FIND_BAR_HEIGHT = 40;
const FIND_BAR_INSET = 8;

/** Where the bar sits, kept as distances from the content's right and top edges. */
interface FindAnchor {
  readonly right: number;
  readonly top: number;
}

/** The area's right edge stays put against the window's when the window resizes, as panels do. */
export function findAnchor(
  area: FindArea,
  zoomFactor: number,
  content: { readonly width: number },
): FindAnchor {
  return { right: content.width - (area.x + area.width) * zoomFactor, top: area.y * zoomFactor };
}

export function findBarBounds(
  anchor: FindAnchor,
  content: { readonly width: number; readonly height: number },
): FindBounds {
  const width = Math.max(0, Math.min(FIND_BAR_WIDTH, content.width - 2 * FIND_BAR_INSET));
  const x = Math.max(FIND_BAR_INSET, content.width - anchor.right - FIND_BAR_INSET - width);
  const y = Math.min(
    Math.max(0, anchor.top + FIND_BAR_INSET),
    Math.max(0, content.height - FIND_BAR_HEIGHT),
  );
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: FIND_BAR_HEIGHT };
}

export type FindController = ReturnType<typeof makeFindController>;

export function makeFindController(target: FindTarget, view: FindBarView) {
  let anchor: FindAnchor | null = null;
  let openZoomFactor = 1;
  let query = "";
  let requestId: number | null = null;

  const search = (findNext: boolean, forward: boolean) => {
    requestId = target.findInPage(query, { findNext, forward });
  };
  const stop = () => {
    requestId = null;
    target.stopFindInPage();
    view.matches(null);
  };
  const step = (forward: boolean) => {
    if (anchor !== null && query !== "") search(false, forward);
  };
  /** `forget` drops the query too, when the page or surface it searched is gone. */
  const close = (options: { readonly forget?: boolean } = {}) => {
    if (options.forget === true) query = "";
    if (anchor === null) return;
    anchor = null;
    stop();
    view.hide();
    target.restoreFocus();
  };

  return {
    isOpen: () => anchor !== null,
    /** Opening again moves the bar and selects the field; a kept query searches again. */
    open: (area: FindArea) => {
      if (anchor === null) target.rememberFocus();
      const content = target.contentSize();
      openZoomFactor = target.zoomFactor();
      anchor = findAnchor(area, openZoomFactor, content);
      view.show(findBarBounds(anchor, content));
      view.focus(query);
      if (query !== "") search(true, true);
    },
    query: (text: string) => {
      if (anchor === null) return;
      query = text;
      if (text === "") stop();
      else search(true, true);
    },
    next: () => step(true),
    previous: () => step(false),
    close,
    /** The anchor came from the zoom at open, so a zoom change closes the bar instead. */
    relayout: () => {
      if (anchor === null) return;
      if (target.zoomFactor() !== openZoomFactor) close();
      else view.place(findBarBounds(anchor, target.contentSize()));
    },
    /** Results of an earlier request, overtaken while typing, are dropped. */
    found: (result: FoundInPage) => {
      if (requestId === null || result.requestId !== requestId) return;
      view.matches({ active: Math.max(0, result.activeMatchOrdinal), total: result.matches });
    },
  };
}

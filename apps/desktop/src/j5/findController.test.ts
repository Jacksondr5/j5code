import { describe, expect, it } from "vite-plus/test";

import type { FindMatches } from "./findBarProtocol.ts";
import {
  FIND_BAR_HEIGHT,
  FIND_BAR_WIDTH,
  findAnchor,
  findBarBounds,
  isFindShortcut,
  makeFindController,
  type FindBounds,
} from "./findController.ts";

function setup(options: { zoomFactor?: number } = {}) {
  const zoom = { factor: options.zoomFactor ?? 1 };
  const content = { width: 1200, height: 800 };
  const calls: string[] = [];
  const matches: (FindMatches | null)[] = [];
  const shown: FindBounds[] = [];
  const focusIsCurrent: (() => boolean)[] = [];
  const bar = { focused: true };
  let nextRequestId = 0;
  const controller = makeFindController(
    {
      findInPage: (text, { findNext, forward }) => {
        nextRequestId += 1;
        calls.push(`find ${text} ${findNext ? "new" : forward ? "next" : "previous"}`);
        return nextRequestId;
      },
      stopFindInPage: () => calls.push("stop"),
      restoreFocus: () => calls.push("restore page focus"),
      zoomFactor: () => zoom.factor,
      contentSize: () => content,
    },
    {
      show: (bounds) => shown.push(bounds),
      place: (bounds) => calls.push(`place at ${bounds.x},${bounds.y}`),
      // A removed view reports no focus, so the close must read focus before hiding.
      hide: () => {
        bar.focused = false;
        calls.push("hide");
      },
      focus: (query, isCurrent) => {
        focusIsCurrent.push(isCurrent);
        calls.push(query === "" ? "focus bar" : `focus bar with ${query}`);
      },
      matches: (value) => matches.push(value),
      isFocused: () => bar.focused,
    },
  );
  return { controller, calls, matches, shown, content, zoom, focusIsCurrent, bar };
}

const panel = { x: 700, y: 48, width: 500, height: 700 };

describe("makeFindController", () => {
  it("starts a session as the query changes and steps with next and previous", () => {
    const { controller, calls, matches } = setup();
    controller.open(panel);
    controller.query("al");
    controller.query("alpha");
    controller.next();
    controller.previous();
    controller.query("");
    controller.next();

    expect(calls).toEqual([
      "focus bar",
      "find al new",
      "find alpha new",
      "find alpha next",
      "find alpha previous",
      "stop",
    ]);
    expect(matches).toEqual([null]);
  });

  it("closes by stopping the find, hiding the bar and refocusing the page, and reopens with its query", () => {
    const { controller, calls } = setup();
    controller.open(panel);
    controller.query("alpha");
    controller.open(panel);
    controller.close();
    controller.close();
    controller.next();
    controller.query("ignored while closed");
    controller.open(panel);

    expect(calls).toEqual([
      "focus bar",
      "find alpha new",
      "focus bar with alpha",
      "find alpha new",
      "stop",
      "hide",
      "restore page focus",
      "focus bar with alpha",
      "find alpha new",
    ]);
    expect(controller.isOpen()).toBe(true);
  });

  it("drops a focus deferred past a close, even when the bar has opened again", () => {
    const { controller, focusIsCurrent } = setup();
    controller.open(panel);
    controller.open(panel);
    controller.close();
    controller.open(panel);

    expect(focusIsCurrent.map((isCurrent) => isCurrent())).toEqual([false, false, true]);
  });

  it("forgets the query when the page it searched goes away, so it never searches the next one", () => {
    const { controller, calls } = setup();
    controller.open(panel);
    controller.query("alpha");
    controller.close({ forget: true });
    controller.open(panel);

    expect(calls).toEqual([
      "focus bar",
      "find alpha new",
      "stop",
      "hide",
      "restore page focus",
      "focus bar",
    ]);
  });

  it("refocuses the preview only when the bar held focus at close", () => {
    const { controller, calls, bar } = setup();
    controller.open(panel);
    bar.focused = false;
    controller.close({ forget: true });
    controller.open(panel);
    bar.focused = true;
    controller.close();

    expect(calls).toEqual([
      "focus bar",
      "stop",
      "hide",
      "focus bar",
      "stop",
      "hide",
      "restore page focus",
    ]);
  });

  it("forwards only the latest request's result", () => {
    const { controller, matches } = setup();
    controller.open(panel);
    controller.query("a"); // request 1
    controller.query("al"); // request 2
    controller.found({ requestId: 1, activeMatchOrdinal: 1, matches: 9 });
    controller.found({ requestId: 2, activeMatchOrdinal: 3, matches: 5 });
    controller.next(); // request 3
    controller.found({ requestId: 3, activeMatchOrdinal: 0, matches: 0 });
    controller.close();
    controller.found({ requestId: 3, activeMatchOrdinal: 4, matches: 5 });

    expect(matches).toEqual([{ active: 3, total: 5 }, { active: 0, total: 0 }, null]);
  });

  it("places the bar at the area's top right and keeps it against the right edge on resize", () => {
    const { controller, calls, shown, content } = setup({ zoomFactor: 1.25 });
    controller.open({ x: 560, y: 40, width: 400, height: 600 });
    content.width = 1000;
    controller.relayout();

    // At 1.25 the area's right edge is 1200 DIPs, flush with the content, and its top is 50.
    expect(shown).toEqual([
      { x: 1200 - 8 - FIND_BAR_WIDTH, y: 58, width: FIND_BAR_WIDTH, height: FIND_BAR_HEIGHT },
    ]);
    expect(calls.at(-1)).toBe(`place at ${1000 - 8 - FIND_BAR_WIDTH},58`);
  });

  it("closes, keeping its query, when the zoom changed since it opened", () => {
    const { controller, calls, shown, zoom } = setup();
    controller.open(panel);
    controller.query("alpha");
    zoom.factor = 1.25;
    controller.relayout();
    controller.relayout();
    controller.open(panel);

    expect(shown).toHaveLength(2);
    expect(calls).toEqual([
      "focus bar",
      "find alpha new",
      "stop",
      "hide",
      "restore page focus",
      "focus bar with alpha",
      "find alpha new",
    ]);
  });
});

describe("isFindShortcut", () => {
  const ctrl = { type: "keyDown", alt: false, shift: false, meta: false, control: true };
  it.each([
    { name: "Ctrl+F", input: { ...ctrl, key: "f", code: "KeyF" }, platform: "linux", match: true },
    {
      name: "Cmd+F on macOS",
      input: { ...ctrl, control: false, meta: true, key: "f", code: "KeyF" },
      platform: "darwin",
      match: true,
    },
    {
      name: "Ctrl+F on macOS",
      input: { ...ctrl, key: "f", code: "KeyF" },
      platform: "darwin",
      match: false,
    },
    {
      name: "Ctrl+Shift+F",
      input: { ...ctrl, shift: true, key: "F", code: "KeyF" },
      platform: "linux",
      match: false,
    },
    {
      name: "the F key on a Russian layout",
      input: { ...ctrl, key: "а", code: "KeyF" },
      platform: "linux",
      match: true,
    },
    // Dvorak puts "u" on the physical F key and "f" on Y.
    {
      name: "Ctrl+U on Dvorak",
      input: { ...ctrl, key: "u", code: "KeyF" },
      platform: "linux",
      match: false,
    },
    {
      name: "Ctrl+F on Dvorak",
      input: { ...ctrl, key: "f", code: "KeyY" },
      platform: "linux",
      match: true,
    },
  ])("$name: $match", ({ input, platform, match }) => {
    expect(isFindShortcut(input, platform)).toBe(match);
  });
});

describe("findBarBounds", () => {
  it.each([
    {
      name: "a panel inset from the right",
      area: { x: 300, y: 100, width: 600, height: 400 },
      content: { width: 1200, height: 800 },
      bounds: { x: 572, y: 108, width: FIND_BAR_WIDTH, height: FIND_BAR_HEIGHT },
    },
    {
      name: "a window narrower than the bar",
      area: { x: 0, y: 0, width: 200, height: 400 },
      content: { width: 200, height: 400 },
      bounds: { x: 8, y: 8, width: 184, height: FIND_BAR_HEIGHT },
    },
    {
      name: "an area below the window's bottom",
      area: { x: 0, y: 900, width: 1200, height: 400 },
      content: { width: 1200, height: 800 },
      bounds: { x: 872, y: 800 - FIND_BAR_HEIGHT, width: FIND_BAR_WIDTH, height: FIND_BAR_HEIGHT },
    },
  ])("fits $name", ({ area, content, bounds }) => {
    expect(findBarBounds(findAnchor(area, 1, content), content)).toEqual(bounds);
  });
});

import { describe, expect, it } from "vite-plus/test";

import type { FindMatches } from "./findBarProtocol.ts";
import {
  FIND_BAR_HEIGHT,
  FIND_BAR_WIDTH,
  findAnchor,
  findBarBounds,
  makeFindController,
  type FindBounds,
} from "./findController.ts";

function setup(options: { zoomFactor?: number } = {}) {
  const content = { width: 1200, height: 800 };
  const calls: string[] = [];
  const matches: (FindMatches | null)[] = [];
  const shown: FindBounds[] = [];
  let nextRequestId = 0;
  const controller = makeFindController(
    {
      findInPage: (text, { findNext, forward }) => {
        nextRequestId += 1;
        calls.push(`find ${text} ${findNext ? "new" : forward ? "next" : "previous"}`);
        return nextRequestId;
      },
      stopFindInPage: () => calls.push("stop"),
      rememberFocus: () => calls.push("remember page focus"),
      restoreFocus: () => calls.push("restore page focus"),
      zoomFactor: () => options.zoomFactor ?? 1,
      contentSize: () => content,
    },
    {
      show: (bounds) => shown.push(bounds),
      hide: () => calls.push("hide"),
      focus: () => calls.push("focus bar"),
      matches: (value) => matches.push(value),
    },
  );
  return { controller, calls, matches, shown, content };
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
      "remember page focus",
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
    // Cmd/Ctrl+F again while open: the page's focus is still the one to go back to.
    controller.open(panel);
    controller.close();
    controller.close();
    controller.next();
    controller.query("ignored while closed");
    controller.open(panel);

    expect(calls).toEqual([
      "remember page focus",
      "focus bar",
      "find alpha new",
      "focus bar",
      "find alpha new",
      "stop",
      "hide",
      "restore page focus",
      "remember page focus",
      "focus bar",
      "find alpha new",
    ]);
    expect(controller.isOpen()).toBe(true);
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
    const { controller, shown, content } = setup({ zoomFactor: 1.25 });
    controller.open({ x: 560, y: 40, width: 400, height: 600 });
    content.width = 1000;
    controller.relayout();

    // At 1.25 the area's right edge is 1200 DIPs, flush with the content, and its top is 50.
    expect(shown).toEqual([
      { x: 1200 - 8 - FIND_BAR_WIDTH, y: 58, width: FIND_BAR_WIDTH, height: FIND_BAR_HEIGHT },
      { x: 1000 - 8 - FIND_BAR_WIDTH, y: 58, width: FIND_BAR_WIDTH, height: FIND_BAR_HEIGHT },
    ]);
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

import type { KnownConnectionAccess } from "@t3tools/client-runtime/j5/sharing";
import { expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({}));

import { opensInInboxBrowser } from "./inboxBrowser";

const person = (wide: boolean): KnownConnectionAccess => ({
  kind: "person",
  personId: "person-1",
  name: "Priya",
  firstOwner: false,
  levels: [],
  wide,
  owner: false,
  retiredLinks: null,
});

const opens = {
  url: "https://example.com/docs",
  event: { metaKey: false, ctrlKey: false },
  preference: "app" as const,
  previewAvailable: true,
  canOperatePreview: true,
  access: person(true),
};

it.each([
  ["a web link with the setting on", {}, true],
  ["a pull request link", { url: "https://github.com/Effect-TS/effect/pull/7" }, true],
  ["a server that has not said who this is", { access: null }, true],
  ["a session that is no person's", { access: { kind: "service" } as const }, true],
  ["the setting left on the system browser", { preference: "system" as const }, false],
  ["a Cmd-click", { event: { metaKey: true, ctrlKey: false } }, false],
  ["a Ctrl-click", { event: { metaKey: false, ctrlKey: true } }, false],
  ["a middle-click", { event: { metaKey: false, ctrlKey: false, button: 1 } }, false],
  ["no browser for that server", { previewAvailable: false }, false],
  ["a pairing without preview access", { canOperatePreview: false }, false],
  ["a person shared only some threads", { access: person(false) }, false],
  ["an unplaced device", { access: { kind: "unknown" } as const }, false],
  ["a mailto link", { url: "mailto:someone@example.com" }, false],
])("in the Inbox browser? %s", (_case, change, expected) => {
  expect(opensInInboxBrowser({ ...opens, ...change })).toBe(expected);
});

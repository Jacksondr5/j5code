import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { askLinkTarget } from "./askLinks.logic";

const ask = EnvironmentId.make("env-ask");
const other = { environmentId: EnvironmentId.make("env-other"), threadId: ThreadId.make("t-2") };

it.each([
  [
    "a v2 thread link opens the thread it names",
    "t3-thread://v2/env-other/t-2",
    other,
    { kind: "thread", thread: other },
  ],
  [
    "a v1 thread link no thread here knows opens in the ask's environment",
    "t3-thread://v1/t-1",
    null,
    { kind: "thread", thread: { environmentId: ask, threadId: ThreadId.make("t-1") } },
  ],
  [
    "a hosted J5 thread link opens the thread",
    "https://j5.codes/threads/env-other/t-2",
    other,
    { kind: "thread", thread: other },
  ],
  [
    "a pull request link goes to the pull request route",
    "https://github.com/acme/billing/pull/42",
    null,
    { kind: "web" },
  ],
  [
    "any other web link goes there too, which opens the browser",
    "https://example.com/docs",
    null,
    { kind: "web" },
  ],
  ["a mail link is left to the caller", "mailto:someone@example.com", null, null],
] as const)("%s", (_name, href, resolved, expected) => {
  expect(askLinkTarget(href, ask, () => resolved)).toEqual(expected);
});

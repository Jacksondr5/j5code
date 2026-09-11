import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import {
  scopedInboxItemKey,
  type HumanInboxItem,
  type HumanInboxResponse,
} from "@t3tools/contracts/j5";

import type { J5ReadSource } from "./readSources.ts";
import { mergeHumanInboxSources, mergeOpenInboxCounts } from "./inbox.ts";

const item: HumanInboxItem = {
  personId: "human:alpha",
  squadronId: "squadron:shared",
  squadronName: "Shared",
  exchangeId: "exchange:shared",
  senderId: "agent:sender",
  senderThreadId: "thread:shared",
  intent: "Question",
  urgency: "soon",
  message: "Proceed?",
  openedAt: "2026-09-08T00:00:00Z",
  status: "open",
  terminalAt: null,
};
const source = <A>(
  id: string,
  data: A,
  overrides: Partial<J5ReadSource<A>> = {},
): J5ReadSource<A> => ({
  environmentId: EnvironmentId.make(id),
  environmentLabel: id,
  connected: true,
  canOperate: true,
  status: "ready",
  data,
  error: null,
  refreshing: false,
  ...overrides,
});

it("merges obligations by urgency and age while retaining each environment and person", () => {
  const sources: Array<J5ReadSource<HumanInboxResponse>> = [
    source("alpha", { personId: "human:alpha", items: [item] }),
    source("bravo", {
      personId: "human:bravo",
      items: [{ ...item, personId: "human:bravo", urgency: "blocking" }],
    }),
  ];
  const items = mergeHumanInboxSources({ isReady: true, sources });
  expect(items.map((row) => [row.environmentId, row.personId])).toEqual([
    ["bravo", "human:bravo"],
    ["alpha", "human:alpha"],
  ]);
  expect(new Set(items.map(scopedInboxItemKey)).size).toBe(2);
  expect(items.every((row) => row.canAnswer)).toBe(true);
});

it("keeps cached obligations visible but cannot send through their disconnected environment", () => {
  const items = mergeHumanInboxSources({
    isReady: true,
    sources: [
      source(
        "offline",
        { personId: item.personId, items: [item] },
        { status: "offline", connected: false, canOperate: false },
      ),
    ],
  });
  expect(items[0]).toMatchObject({ environmentId: "offline", canAnswer: false, connected: false });
});

it("sums known counts without treating an unavailable source as a known zero", () => {
  const result = mergeOpenInboxCounts({
    isReady: true,
    sources: [
      source("alpha", { personId: "human:alpha", count: 2 }),
      source(
        "bravo",
        { personId: "human:bravo", count: 3 },
        { status: "offline", connected: false },
      ),
    ],
  });
  expect(result).toEqual({ count: 5, incomplete: true });
  expect(
    mergeOpenInboxCounts({
      isReady: true,
      sources: [
        source("unknown", { personId: "human:unknown", count: 0 }, { data: null, status: "error" }),
      ],
    }),
  ).toEqual({ count: null, incomplete: true });
});

import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { CrewRuntimeRequestItem } from "@t3tools/contracts/j5";

import {
  inboxBadgeCount,
  inboxRequestIdsForThread,
  mergeCrewRuntimeRequestSources,
  withoutInboxRequests,
} from "./crewRuntimeRequests.logic";

const envA = EnvironmentId.make("env:a");
const envB = EnvironmentId.make("env:b");
const seatThread = ThreadId.make("thread:builder");
const soloThread = ThreadId.make("thread:solo");

const item = (requestId: string, threadId = seatThread): CrewRuntimeRequestItem => ({
  threadId,
  requestId: RuntimeRequestId.make(requestId),
  crewInstanceId: "crew:1",
  crewName: "Release Crew",
  squadronId: "squadron:1",
  seat: "builder",
  threadTitle: "builder",
  createdAt: "2026-09-24T12:00:00.000Z",
  responseCapability: "live",
  request: {
    kind: "approval",
    requestKind: "command",
    detail: "Run the tests?",
    appName: null,
    options: null,
  },
});

const sources = (
  byEnvironment: ReadonlyArray<[EnvironmentId, ReadonlyArray<CrewRuntimeRequestItem>]>,
) =>
  ({
    isReady: true,
    sources: byEnvironment.map(([environmentId, data]) => ({ environmentId, data })),
  }) as never;

const pending = (...ids: ReadonlyArray<string>) => ({
  approvals: ids.filter((id) => id.startsWith("a")).map((requestId) => ({ requestId })),
  userInputs: ids.filter((id) => id.startsWith("q")).map((requestId) => ({ requestId })),
});

describe("Crew thread requests answered from the Inbox", () => {
  const merged = mergeCrewRuntimeRequestSources(
    sources([
      [envA, [item("a1"), item("q1")]],
      // The same local thread id on another environment is a different thread.
      [envB, [item("a9")]],
    ]),
  );

  it("moves the Inbox's requests off a Crew thread's composer and keeps the rest inline", () => {
    const ids = inboxRequestIdsForThread(merged, envA, seatThread);
    expect([...ids].toSorted()).toEqual(["a1", "q1"]);
    // A request the Inbox has not read yet stays inline, so nothing is hidden from both places.
    expect(withoutInboxRequests(pending("a1", "q1", "a2"), ids)).toEqual(pending("a2"));
  });

  it("leaves a thread outside any Crew with its inline panels", () => {
    const ids = inboxRequestIdsForThread(merged, envA, soloThread);
    expect(ids.size).toBe(0);
    const solo = pending("a1", "q7");
    expect(withoutInboxRequests(solo, ids)).toBe(solo);
    expect(inboxRequestIdsForThread(merged, undefined, seatThread).size).toBe(0);
    expect(inboxRequestIdsForThread(merged, envA, null).size).toBe(0);
  });

  it("leaves a request the Inbox cannot answer in the composer as well", () => {
    const notLive = mergeCrewRuntimeRequestSources(
      sources([
        [
          envA,
          [
            { ...item("q-message"), responseCapability: "message" },
            { ...item("a-gone"), responseCapability: "not_resumable" },
            item("a-live"),
          ],
        ],
      ]),
    );
    expect([...inboxRequestIdsForThread(notLive, envA, seatThread)]).toEqual(["a-live"]);
  });

  it("scopes a thread's requests to its own environment", () => {
    expect([...inboxRequestIdsForThread(merged, envB, seatThread)]).toEqual(["a9"]);
  });

  it("counts Crew requests on the bell, up while waiting and back down once answered", () => {
    expect(inboxBadgeCount(2, 0, 0)).toBe(2);
    expect(inboxBadgeCount(2, 1, merged.length)).toBe(6);
    const afterAnswer = mergeCrewRuntimeRequestSources(
      sources([
        [envA, [item("q1")]],
        [envB, []],
      ]),
    );
    expect(inboxBadgeCount(2, 1, afterAnswer.length)).toBe(4);
    // Asks unread, Crew items read: still counted; nothing at all reads as no badge.
    expect(inboxBadgeCount(null, 0, 1)).toBe(1);
    expect(inboxBadgeCount(null, 0, 0)).toBeNull();
  });
});

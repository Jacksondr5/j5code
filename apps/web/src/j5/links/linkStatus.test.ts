import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import { peerCredentialRejectedReason } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import type { PeerRecord } from "../peering/peeringClient";
import { linkPairs } from "./linkPairs";
import { messagesStatusOf } from "./linkStatus";

const LAPTOP = EnvironmentId.make("environment-laptop");
const WORK = EnvironmentId.make("environment-work");
const NOW = Date.parse("2026-11-19T12:00:00.000Z");

const record = (environmentId: string, label: string, fields: Partial<PeerRecord>) =>
  ({
    environmentId,
    label,
    origin: null,
    lineAddress: null,
    lastPolledAt: null,
    lastError: null,
    inboundSession: "active",
    waitingCount: 0,
    oldestWaitingAt: null,
    ...fields,
  }) as PeerRecord;

const toLaptop: PeerLinkSummary = {
  environmentId: LAPTOP,
  label: "Laptop",
  urls: ["http://127.77.0.1:1"],
  access: "approval-required",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
};

const pollingPair = (workLinks: ReadonlyArray<PeerLinkSummary>, workSees: Partial<PeerRecord>) =>
  linkPairs([
    {
      environmentId: LAPTOP,
      label: "Laptop",
      peers: [record(WORK, "Work", { linkMode: "poll", origin: "https://work.example" })],
      links: [],
    },
    {
      environmentId: WORK,
      label: "Work",
      peers: [record(LAPTOP, "Laptop", { linkMode: "store", ...workSees })],
      links: workLinks,
    },
  ])[0]!;

it("says who polls whom from either side, and what a storing server's tools can reach", () => {
  const quiet = messagesStatusOf(pollingPair([], {}), NOW)!;
  expect(quiet.travel).toBe("Laptop polls Work for messages");
  expect(quiet.reach, "with no tools towards the poller there is nothing to say").toBeNull();
  expect(quiet.problems).toEqual([]);

  const linked = messagesStatusOf(pollingPair([toLaptop], {}), NOW)!;
  expect(linked.reach).toBe("Work's agents reach Laptop only while Laptop is running");
});

it("reports a server that ended messaging, and one that holds no record, as problems", () => {
  const ended = linkPairs([
    {
      environmentId: LAPTOP,
      label: "Laptop",
      peers: [
        record(WORK, "Work", {
          linkMode: "push",
          origin: "https://work.example",
          lastError: peerCredentialRejectedReason("Work"),
        }),
      ],
      links: [],
    },
    { environmentId: WORK, label: "Work", peers: [], links: [] },
  ])[0]!;
  const status = messagesStatusOf(ended, NOW)!;
  expect(status.travel).toBe("Not travelling: only Laptop records Work");
  expect(status.problems).toEqual([
    "Work ended messaging with Laptop. Remove the link, then link them again.",
    "Work holds no record of Laptop",
  ]);
});

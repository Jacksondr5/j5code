import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { PeerRecord } from "../peering/peeringClient";
import { pairTitle } from "../peering/peerPairs";
import {
  linkPairs,
  pairHasMessaging,
  toolsAddressOf,
  toolsExpiryOf,
  toolsLevelOf,
  type ManagedLinkList,
} from "./linkPairs";

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE = EnvironmentId.make("environment-remote");
const VM = EnvironmentId.make("environment-vm");
const NOW = DateTime.makeUnsafe("2026-11-19T12:00:00.000Z");

const record = (environmentId: string, label: string, fields: Partial<PeerRecord> = {}) =>
  ({
    environmentId,
    label,
    linkMode: "push",
    origin: null,
    lineAddress: null,
    ...fields,
  }) as PeerRecord;

const link = (
  environmentId: EnvironmentId,
  label: string,
  fields: Partial<PeerLinkSummary> = {},
): PeerLinkSummary => ({
  environmentId,
  label,
  urls: [`https://${label.toLowerCase()}.example`],
  access: "approval-required",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
  ...fields,
});

const titles = (lists: ReadonlyArray<ManagedLinkList>) => linkPairs(lists).map(pairTitle);

describe("linkPairs", () => {
  it("is one row for a pair, whether peer records, links or both record it", () => {
    const lists: ReadonlyArray<ManagedLinkList> = [
      {
        environmentId: REMOTE,
        label: "Remote",
        peers: [record(LOCAL, "Local")],
        links: [link(LOCAL, "Local", { access: "full-access" })],
      },
      {
        environmentId: LOCAL,
        label: "Local",
        peers: [record(REMOTE, "Remote")],
        links: [link(VM, "Work VM")],
      },
      { environmentId: VM, label: "Work VM", peers: [], links: [] },
    ];

    const [withRemote, withVm] = linkPairs(lists);
    expect(titles(lists)).toEqual(["Local ↔ Remote", "Local ↔ Work VM"]);
    expect(withRemote!.sides.map((side) => side.record?.environmentId)).toEqual([REMOTE, LOCAL]);
    expect(withRemote!.sides.map(toolsLevelOf)).toEqual(["off", "full-access"]);
    expect(pairHasMessaging(withRemote!)).toBe(true);

    expect(withVm!.sides.map(toolsLevelOf), "a link alone makes the pair").toEqual([
      "approval-required",
      "off",
    ]);
    expect(pairHasMessaging(withVm!), "its tools work with no messaging").toBe(false);
  });

  it("keeps a pair between two servers that are not this client's own, beside its own pairs", () => {
    expect(
      titles([
        { environmentId: LOCAL, label: "Local", peers: [], links: [] },
        { environmentId: REMOTE, label: "Remote", peers: [record(VM, "Work VM")], links: [] },
        { environmentId: VM, label: "Work VM", peers: [record(REMOTE, "Remote")], links: [] },
      ]),
    ).toEqual(["Remote ↔ Work VM"]);
  });

  it("tells a server holding nothing apart from one this client could not read, or cannot manage", () => {
    const [withMac, withRemote, withVm] = linkPairs([
      {
        environmentId: LOCAL,
        label: "Local",
        peers: [record(REMOTE, "Remote"), record(VM, "VM")],
        links: [link(EnvironmentId.make("environment-mac"), "Mac")],
      },
      { environmentId: REMOTE, label: "Remote", peers: [], links: [] },
      { environmentId: VM, label: "Work VM", peers: null, links: null },
    ]);

    expect(withMac!.sides[1], "named as the link names it").toMatchObject({
      label: "Mac",
      managed: false,
      link: null,
      linksRead: false,
    });
    expect(withRemote!.sides[1]).toMatchObject({
      label: "Remote",
      record: null,
      read: true,
      linksRead: true,
    });
    expect(withVm!.sides[1]).toMatchObject({
      label: "Work VM",
      managed: true,
      record: null,
      read: false,
      linksRead: false,
    });
  });
});

describe("toolsAddressOf", () => {
  it("is the address messages already take: the origin, or a poller's line", () => {
    expect(toolsAddressOf(record(REMOTE, "Remote", { origin: "https://remote.example" }))).toBe(
      "https://remote.example",
    );
    expect(
      toolsAddressOf(
        record(REMOTE, "Remote", { linkMode: "poll", origin: "https://remote.example" }),
      ),
    ).toBe("https://remote.example");
    expect(
      toolsAddressOf(
        record(LOCAL, "Local", { linkMode: "store", lineAddress: "http://127.77.0.1:1" }),
      ),
      "a server that stores for a poller reaches it through its line",
    ).toBe("http://127.77.0.1:1");
    expect(toolsAddressOf(record(LOCAL, "Local", { linkMode: "store" }))).toBeNull();
    expect(toolsAddressOf(null)).toBeNull();
  });
});

describe("toolsExpiryOf", () => {
  const pairWith = (...expiries: ReadonlyArray<Partial<PeerLinkSummary> | null>) =>
    linkPairs([
      {
        environmentId: LOCAL,
        label: "Local",
        peers: [record(REMOTE, "Remote")],
        links: expiries[0] == null ? [] : [link(REMOTE, "Remote", expiries[0])],
      },
      {
        environmentId: REMOTE,
        label: "Remote",
        peers: [record(LOCAL, "Local")],
        links: expiries[1] == null ? [] : [link(LOCAL, "Local", expiries[1])],
      },
    ])[0]!;
  const at = (iso: string) => ({ expiresAt: DateTime.makeUnsafe(iso) });

  it("is the earlier direction's, warns in the last five days, and is expired when either is", () => {
    expect(toolsExpiryOf(pairWith(null, null), NOW)).toEqual({ kind: "none" });
    expect(
      toolsExpiryOf(pairWith(at("2026-12-10T00:00:00.000Z"), at("2026-12-01T00:00:00.000Z")), NOW),
    ).toMatchObject({ kind: "running", soon: false, at: at("2026-12-01T00:00:00.000Z").expiresAt });
    expect(
      toolsExpiryOf(pairWith(at("2026-11-24T12:00:00.000Z"), null), NOW),
      "five days is inside upstream's warning",
    ).toMatchObject({ kind: "running", soon: true });
    expect(toolsExpiryOf(pairWith(at("2026-11-24T12:00:01.000Z"), null), NOW)).toMatchObject({
      kind: "running",
      soon: false,
    });
    expect(
      toolsExpiryOf(pairWith(at("2026-12-10T00:00:00.000Z"), at("2026-11-17T00:00:00.000Z")), NOW),
    ).toMatchObject({ kind: "expired" });
    expect(
      toolsExpiryOf(pairWith({ status: "expired" }, null), NOW),
      "a link from before fencing counts as expired whatever its date",
    ).toMatchObject({ kind: "expired" });
    expect(
      toolsExpiryOf(
        pairWith(at("2026-12-01T00:00:00.000Z"), {
          ...at("2026-12-10T00:00:00.000Z"),
          status: "expired",
        }),
        NOW,
      ),
      "the later direction's expired status counts too",
    ).toMatchObject({ kind: "expired" });
  });
});

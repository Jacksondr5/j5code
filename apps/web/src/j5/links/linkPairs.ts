import { type AuthMcpClientAccess, EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

import type { PeerRecord } from "../peering/peeringClient";
import type { ManagedPeerList, PeerPair, PeerPairSide } from "../peering/peerPairs";

/** What one server's agents may do on the other: nothing beyond messages, or one of upstream's levels. */
export type ToolsLevel = "off" | AuthMcpClientAccess;

/** One server this client manages: its peer records and its links, each when it could be read. */
export interface ManagedLinkList extends ManagedPeerList {
  readonly links: ReadonlyArray<PeerLinkSummary> | null;
}

/** One server of a linked pair. Its `link` is what its own agents may do on the other server. */
export interface LinkPairSide extends PeerPairSide {
  readonly link: PeerLinkSummary | null;
  /** This client read this server's links, so a null link means it holds none. */
  readonly linksRead: boolean;
}

export interface LinkPair extends PeerPair {
  readonly sides: readonly [LinkPairSide, LinkPairSide];
}

/**
 * Every pair the managed servers record, by a peer record, a link or both, one row per pair. A
 * server outside the managed set appears only as the other side, under the name recorded for it.
 */
export function linkPairs(lists: ReadonlyArray<ManagedLinkList>): ReadonlyArray<LinkPair> {
  const listOf = new Map(lists.map((list) => [list.environmentId, list]));
  const pairs = new Map<string, LinkPair>();
  const add = (owner: ManagedLinkList, otherId: EnvironmentId, otherLabel: string) => {
    const key = [owner.environmentId, otherId].toSorted().join("|");
    if (pairs.has(key)) return;
    const side = (environmentId: EnvironmentId, other: EnvironmentId): LinkPairSide => {
      const managed = listOf.get(environmentId);
      return {
        environmentId,
        label: managed?.label ?? otherLabel,
        managed: managed !== undefined,
        record: managed?.peers?.find((peer) => peer.environmentId === other) ?? null,
        read: (managed?.peers ?? null) !== null,
        link: managed?.links?.find((link) => link.environmentId === other) ?? null,
        linksRead: (managed?.links ?? null) !== null,
      };
    };
    const sides = [side(owner.environmentId, otherId), side(otherId, owner.environmentId)].toSorted(
      (left, right) => left.label.localeCompare(right.label),
    );
    pairs.set(key, { key, sides: [sides[0]!, sides[1]!] });
  };
  for (const list of lists) {
    for (const record of list.peers ?? []) {
      add(list, EnvironmentId.make(record.environmentId), record.label);
    }
    for (const link of list.links ?? []) add(list, link.environmentId, link.label);
  }
  return [...pairs.values()].toSorted((left, right) =>
    `${left.sides[0].label} ${left.sides[1].label}`.localeCompare(
      `${right.sides[0].label} ${right.sides[1].label}`,
    ),
  );
}

export const otherSideOf = (pair: LinkPair, side: LinkPairSide): LinkPairSide =>
  pair.sides[0] === side ? pair.sides[1] : pair.sides[0];

export const toolsLevelOf = (side: LinkPairSide): ToolsLevel => side.link?.access ?? "off";

/** Whether the two servers exchange messages: either one this client read records the other. */
export const pairHasMessaging = (pair: LinkPair): boolean =>
  pair.sides.some((side) => side.record !== null);

/**
 * Where a server's link to the other is made: the address its messages already go to, or, for a
 * server that stores messages for a poller, the poller's line. Null when it records neither.
 */
export const toolsAddressOf = (record: PeerRecord | null): string | null =>
  record === null ? null : record.linkMode === "store" ? record.lineAddress : record.origin;

/** The days before expiry in which upstream's own link row starts to warn. */
const RENEW_SOON_DAYS = 5;

export type ToolsExpiry =
  | { readonly kind: "none" }
  | { readonly kind: "expired"; readonly at: DateTime.Utc }
  /** `soon` is upstream's own warning window, when Renew is offered on the row itself. */
  | { readonly kind: "running"; readonly at: DateTime.Utc; readonly soon: boolean };

/** When a pair's tools run out: the earlier of its two directions, and expired if either is. */
export function toolsExpiryOf(pair: LinkPair, now: DateTime.Utc): ToolsExpiry {
  const links = pair.sides.flatMap((side) => (side.link === null ? [] : [side.link]));
  const first = links.toSorted(
    (left, right) => left.expiresAt.epochMilliseconds - right.expiresAt.epochMilliseconds,
  )[0];
  if (first === undefined) return { kind: "none" };
  const left = first.expiresAt.epochMilliseconds - now.epochMilliseconds;
  // The server's own verdict counts for either direction, whatever this client's clock says.
  const expired = links.find((link) => link.status === "expired");
  if (expired !== undefined) return { kind: "expired", at: expired.expiresAt };
  if (left <= 0) return { kind: "expired", at: first.expiresAt };
  return { kind: "running", at: first.expiresAt, soon: left <= RENEW_SOON_DAYS * 86_400_000 };
}

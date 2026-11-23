import {
  isPeerCredentialRejected,
  peerPollState,
  peerPollStoppedReason,
} from "@t3tools/contracts/j5";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  otherSideOf,
  toolsLevelOf,
  type LinkPair,
  type LinkPairSide,
  type ToolsExpiry,
} from "./linkPairs";

type RecordedSide = LinkPairSide & { readonly record: NonNullable<LinkPairSide["record"]> };

const isRecorded = (side: LinkPairSide): side is RecordedSide => side.record !== null;

export interface MessagesStatus {
  /** How messages travel between the two servers. */
  readonly travel: string;
  /** Whether a server that polls is there now, and what is waiting for it. */
  readonly state: string | null;
  /** What a server that stores for a poller can reach, when its agents have tools there. */
  readonly reach: string | null;
  /** What is wrong on either side, each as its own line. */
  readonly problems: ReadonlyArray<string>;
}

const sideState = (side: RecordedSide, other: string, nowMs: number): string | null => {
  const state = peerPollState(side.record, nowMs);
  const polling =
    state === null
      ? null
      : state.kind === "never"
        ? side.record.linkMode === "store"
          ? `${other} has not polled yet`
          : "not polled yet"
        : state.kind === "online"
          ? `online · last polled ${formatRelativeTimeLabel(state.lastPolledAt, nowMs)}`
          : `offline since ${formatRelativeTimeLabel(state.since, nowMs)}`;
  const waiting =
    side.record.waitingCount > 0 && side.record.oldestWaitingAt !== null
      ? `${String(side.record.waitingCount)} waiting · oldest ${formatRelativeTimeLabel(side.record.oldestWaitingAt, nowMs)}`
      : null;
  const parts = [polling, waiting].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
};

const sideProblem = (side: RecordedSide, other: string): string | null => {
  const peer = side.record;
  if (isPeerCredentialRejected(peer)) {
    return `${other} ended messaging with ${side.label}. Remove the link, then link them again.`;
  }
  const stopped = peerPollStoppedReason(peer);
  if (stopped !== null) return `${side.label}: polling stopped. ${stopped}`;
  if (peer.lastError !== null) return `${side.label}: ${peer.lastError}`;
  return peer.linkMode === "push" && peer.inboundSession === "missing"
    ? `${side.label}: no live session for ${other}, so its messages are refused`
    : null;
};

/** The messages part of a pair, or null when neither server this client read records the other. */
export function messagesStatusOf(pair: LinkPair, nowMs: number): MessagesStatus | null {
  const recorded = pair.sides.filter(isRecorded);
  const holder = recorded[0];
  if (holder === undefined) return null;
  const storer =
    holder.record.linkMode === "store"
      ? holder
      : holder.record.linkMode === "poll"
        ? otherSideOf(pair, holder)
        : null;
  const poller = storer === null ? null : otherSideOf(pair, storer);
  // A storer's record carries its poller's heartbeat and what waits for it, so it speaks first.
  const speaker = recorded.find((side) => side === storer) ?? holder;
  const halfRecorded = pair.sides.some((side) => side.read && !isRecorded(side));
  return {
    travel: halfRecorded
      ? `Not travelling: only ${holder.label} records ${otherSideOf(pair, holder).label}`
      : storer === null || poller === null
        ? "Sent directly both ways"
        : `${poller.label} polls ${storer.label} for messages`,
    state: sideState(speaker, otherSideOf(pair, speaker).label, nowMs),
    reach:
      storer !== null && poller !== null && toolsLevelOf(storer) !== "off"
        ? `${storer.label}'s agents reach ${poller.label} only while ${poller.label} is running`
        : null,
    problems: pair.sides.flatMap((side) => {
      const other = otherSideOf(pair, side).label;
      if (isRecorded(side)) return sideProblem(side, other) ?? [];
      if (!side.read) return [];
      // A server that ended messaging already says what to do; this one adds only the fact.
      return [
        recorded.some((each) => isPeerCredentialRejected(each.record))
          ? `${side.label} holds no record of ${other}`
          : `${side.label} holds no record of ${other}. Link them again to repair it, or remove the link.`,
      ];
    }),
  };
}

const DAY_MS = 86_400_000;

const days = (count: number) => `${String(count)} ${count === 1 ? "day" : "days"}`;

/** When a pair's tools run out, in the row's words; null when no direction has any. */
export function toolsExpiryLine(
  expiry: ToolsExpiry,
  nowMs: number,
  messaging: boolean,
): string | null {
  if (expiry.kind === "none") return null;
  const distance = Math.abs(expiry.at.epochMilliseconds - nowMs);
  if (expiry.kind === "running") {
    return `Tool access runs out in ${days(Math.max(1, Math.ceil(distance / DAY_MS)))}`;
  }
  const ago = Math.floor(distance / DAY_MS);
  return `Tool access ran out ${ago === 0 ? "today" : `${days(ago)} ago`}.${messaging ? " Messages still work." : ""}`;
}

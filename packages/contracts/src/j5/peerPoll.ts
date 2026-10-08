/**
 * Online and offline for a peer in poll mode, read the same way by every
 * surface that shows it. A poller polls at least every half-minute while it
 * runs, so a peer is online while it polled within this window, and offline
 * since its last poll after that.
 */
export const PEER_ONLINE_WINDOW_MS = 2 * 60_000;

/** Online, offline since, or never polled, for a peer in poll mode; null for one that sends directly. */
export const peerPollState = (
  peer: { readonly linkMode: "push" | "store" | "poll"; readonly lastPolledAt: string | null },
  nowMs: number,
):
  | { readonly kind: "online"; readonly lastPolledAt: string }
  | { readonly kind: "offline"; readonly since: string }
  | { readonly kind: "never" }
  | null => {
  if (peer.linkMode === "push") return null;
  if (peer.lastPolledAt === null) return { kind: "never" };
  return nowMs - Date.parse(peer.lastPolledAt) <= PEER_ONLINE_WINDOW_MS
    ? { kind: "online", lastPolledAt: peer.lastPolledAt }
    : { kind: "offline", since: peer.lastPolledAt };
};

const CREDENTIAL_REJECTED =
  "rejected this server's credential (HTTP 401). Peer again to issue a new one.";

/** The reason a poller records when the storing server rejects its credential; polling stops until they peer again. */
export const peerCredentialRejectedReason = (label: string) => `${label} ${CREDENTIAL_REJECTED}`;

/** The mark a poller puts on the peer's last error when it stops polling. */
export const PEER_POLL_STOPPED_PREFIX = "Polling stopped: ";
const POLLING_STOPPED = PEER_POLL_STOPPED_PREFIX;

/** What a poller records when it stops polling, which only peering again or an update restarts. */
export const peerPollStoppedError = (reason: string) => `${POLLING_STOPPED}${reason}`;

/**
 * Why polling stopped, from what the poller recorded when it stopped; null
 * while it polls, after a failure it retries, and for a peer that does not poll.
 */
export const peerPollStoppedReason = (peer: {
  readonly linkMode: "push" | "store" | "poll";
  readonly lastError: string | null;
}) =>
  peer.linkMode === "poll" && peer.lastError?.startsWith(POLLING_STOPPED) === true
    ? peer.lastError.slice(POLLING_STOPPED.length)
    : null;

/**
 * Whether polling stopped because the credential was rejected, which only
 * peering again fixes. Read from the poller's stop, so a retried failure that
 * quotes the same words is not one.
 */
export const isPeerCredentialRejected = (peer: {
  readonly linkMode: "push" | "store" | "poll";
  readonly lastError: string | null;
}) => peerPollStoppedReason(peer)?.endsWith(CREDENTIAL_REJECTED) === true;

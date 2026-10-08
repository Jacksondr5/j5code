import { PEER_PROTOCOL_HEADER, PEER_PROTOCOL_VERSION } from "@t3tools/contracts/j5";

/**
 * The one compare for both directions of peering. A server states its peer
 * protocol version on every request it sends and every response it answers,
 * and each side checks what the other stated here, so a mismatch is caught
 * whichever server was updated. A missing header is a server from before
 * versioning, which counts as version 1.
 */

/** The header this server sends on every peer request and response. */
export const peerProtocolHeaders = { [PEER_PROTOCOL_HEADER]: String(PEER_PROTOCOL_VERSION) };

/**
 * Null when the stated version matches this server's; otherwise the reason,
 * naming which server to update. `stated` is what the other server said, from
 * a header or a hello body; a server that said nothing counts as version 1.
 * Only a whole number is a version: anything else is the other server's fault,
 * and the reason never repeats what it sent.
 */
export const peerProtocolMismatch = (input: {
  readonly stated: string | number | undefined;
  /** How this server names the other one in the reason. */
  readonly peer: string;
}): string | null => {
  const stated = input.stated ?? 1;
  const version =
    typeof stated === "number"
      ? Number.isSafeInteger(stated)
        ? stated
        : null
      : /^\d+$/.test(stated)
        ? Number(stated)
        : null;
  if (version === null) {
    return `${input.peer} sent an unreadable peer protocol version. Update J5 on ${input.peer}, then try again.`;
  }
  if (version === PEER_PROTOCOL_VERSION) return null;
  // The other server is named at the start of the sentence only: some callers name it with a phrase.
  const where = version < PEER_PROTOCOL_VERSION ? "there" : "on this server";
  return `${input.peer} runs peer protocol ${String(version)} and this server runs ${String(PEER_PROTOCOL_VERSION)}. Update J5 ${where}, then try again.`;
};

/** The version a peer request or response states in its header. */
export const statedPeerProtocol = (headers: Readonly<Record<string, string | undefined>>) =>
  headers[PEER_PROTOCOL_HEADER];

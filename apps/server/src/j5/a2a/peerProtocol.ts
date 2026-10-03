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
 */
export const peerProtocolMismatch = (input: {
  readonly stated: string | number | undefined;
  /** How this server names the other one in the reason. */
  readonly peer: string;
}): string | null => {
  const stated = String(input.stated ?? 1);
  if (Number(stated) === PEER_PROTOCOL_VERSION) return null;
  const older = Number(stated) < PEER_PROTOCOL_VERSION ? input.peer : "this server";
  return `${input.peer} runs peer protocol ${stated} and this server runs ${String(PEER_PROTOCOL_VERSION)}. Update J5 on ${older}, then try again.`;
};

/** The version a peer request or response states in its header. */
export const statedPeerProtocol = (headers: Readonly<Record<string, string | undefined>>) =>
  headers[PEER_PROTOCOL_HEADER];

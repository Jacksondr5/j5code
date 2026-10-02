import * as NodeCrypto from "node:crypto";

import type { A2ARosterEntry, PeerRosterAgent } from "@t3tools/contracts/j5";

/**
 * The one thing a peer may read of this server: the agents it could address,
 * by Squadron, and nothing about people, machines or liveness. The roster
 * route answers with it, and a poller sends it to the server that stores its
 * messages whenever it changes.
 */
export const toPeerRoster = (entries: ReadonlyArray<A2ARosterEntry>): Array<PeerRosterAgent> =>
  entries.flatMap((entry) =>
    entry.kind === "agent" &&
    entry.squadronId !== null &&
    entry.squadronName !== null &&
    entry.threadId !== null
      ? [
          {
            participantId: entry.participantId,
            squadronId: entry.squadronId,
            squadronName: entry.squadronName,
            threadId: entry.threadId,
            displayName: entry.displayName,
            archived: entry.archived,
            canReceiveMessage: entry.canReceiveMessage,
          },
        ]
      : [],
  );

/**
 * Changes only when an agent is added, renamed, archived or moved: the roster
 * carries no liveness or time, so a poller resends its roster only then.
 */
export const peerRosterHash = (agents: ReadonlyArray<PeerRosterAgent>): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        agents
          .map((agent) => [
            agent.participantId,
            agent.squadronId,
            agent.squadronName,
            agent.threadId,
            agent.displayName,
            agent.archived,
            agent.canReceiveMessage,
          ])
          .toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
      ),
    )
    .digest("hex");

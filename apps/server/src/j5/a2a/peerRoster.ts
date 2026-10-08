import * as NodeCrypto from "node:crypto";

import type { A2ARosterEntry, PeerRosterAgent } from "@t3tools/contracts/j5";

/**
 * The one thing a peer may read of this server: the agents it could address,
 * by project, and nothing about people, machines or liveness. The roster
 * route answers with it, and a poller sends it to the server that stores its
 * messages whenever it changes.
 */
export const toPeerRoster = (entries: ReadonlyArray<A2ARosterEntry>): Array<PeerRosterAgent> =>
  entries.flatMap((entry) =>
    entry.kind === "agent" &&
    entry.projectId !== null &&
    entry.projectTitle !== null &&
    entry.threadId !== null
      ? [
          {
            participantId: entry.participantId,
            // The peer wire still names the project a Squadron.
            squadronId: entry.projectId,
            squadronName: entry.projectTitle,
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

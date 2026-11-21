import type { EnvironmentId } from "@t3tools/contracts";

import type { PeerRecord } from "./peeringClient";

/** One server this client manages, and its peer records when they were read. */
export interface ManagedPeerList {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly peers: ReadonlyArray<PeerRecord> | null;
}

/** One server of a peered pair, as this client sees it. */
export interface PeerPairSide {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** This client manages this server, whether or not its peers could be read. */
  readonly managed: boolean;
  /** This server's record of the other one; null when it holds none, or when `read` is false. */
  readonly record: PeerRecord | null;
  /** This client read this server's peers, so a null record means it holds none. */
  readonly read: boolean;
}

/** The messages part of a linked pair; `links/linkPairs.ts` builds the pairs, with their links. */
export interface PeerPair {
  readonly key: string;
  readonly sides: readonly [PeerPairSide, PeerPairSide];
}

export const pairTitle = (pair: PeerPair) => `${pair.sides[0].label} ↔ ${pair.sides[1].label}`;

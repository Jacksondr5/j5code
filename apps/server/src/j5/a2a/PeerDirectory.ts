import type { ThreadId } from "@t3tools/contracts";
import { J5_PEER_API_PATHS, PeerRosterResponse, type PeerRosterAgent } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  PeerRegistryService,
  type PeerConnection,
  type PeerRegistryServiceShape,
  type PeerSessionReadError,
} from "./PeerRegistryService.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";
import { peerProtocolHeaders, peerProtocolMismatch, statedPeerProtocol } from "./peerProtocol.ts";

/**
 * The address book across peers. Every read asks each peer this server
 * connects to for its roster live: peers are few and a live answer is never
 * stale, and a peer that does not answer is reported as unread rather than
 * guessed at. A peer that polls this server is never called; its roster is the
 * snapshot it sent with its last poll, and before its first it is unread. Once this server has a
 * peer, a reading names this server and each peer by its own name, so agents
 * see where each participant lives; they still address it by id.
 */

const PEER_ROSTER_TIMEOUT = Duration.seconds(5);

export interface RemoteAgent {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly squadronId: SquadronId;
  readonly squadronName: string;
  readonly participantId: ParticipantId;
  readonly threadId: ThreadId;
  readonly displayName: string | null;
  readonly archived: boolean;
  readonly canReceiveMessage: boolean;
}

export interface UnreadPeer {
  readonly environmentId: string;
  readonly label: string;
  readonly reason: string;
}

export interface PeerDirectoryReading {
  readonly agents: ReadonlyArray<RemoteAgent>;
  readonly unreadPeers: ReadonlyArray<UnreadPeer>;
  /** This server's name, or null when it has no peers and so names no server at all. */
  readonly selfName: string | null;
}

export type PeerDirectoryError = SqlError | PeerSessionReadError;

export interface PeerDirectoryShape {
  readonly listAgents: () => Effect.Effect<PeerDirectoryReading, PeerDirectoryError>;
  /** The agents with this id across every readable peer; more than one is the caller's ambiguity to refuse. */
  readonly resolveAgent: (
    participantId: ParticipantId,
  ) => Effect.Effect<PeerDirectoryReading, PeerDirectoryError>;
  /**
   * The agent as the snapshot from a peer that polls this server shows it,
   * without any network read; null for a peer this server reads live, or one
   * that has not polled yet.
   */
  readonly snapshotAgent: (
    environmentId: string,
    participantId: ParticipantId,
  ) => Effect.Effect<RemoteAgent | null, PeerDirectoryError>;
  /** A peer server's name as last reported, or its environment id once it is no longer recorded. */
  readonly serverName: (environmentId: string) => Effect.Effect<string, PeerDirectoryError>;
}

export class PeerDirectory extends Context.Service<PeerDirectory, PeerDirectoryShape>()(
  "t3/j5/a2a/PeerDirectory",
) {}

/** No peers: every read is empty and nothing is unread. For layers built without peering. */
export const noneLayer = Layer.succeed(
  PeerDirectory,
  PeerDirectory.of({
    listAgents: () => Effect.succeed({ agents: [], unreadPeers: [], selfName: null }),
    resolveAgent: () => Effect.succeed({ agents: [], unreadPeers: [], selfName: null }),
    snapshotAgent: () => Effect.succeed(null),
    serverName: (environmentId) => Effect.succeed(environmentId),
  }),
);

const decodeRoster = Schema.decodeUnknownEffect(PeerRosterResponse);

class PeerRosterStatusError extends Schema.TaggedError<PeerRosterStatusError>()(
  "PeerRosterStatusError",
  { status: Schema.Number },
) {
  override get message(): string {
    return `the roster route answered HTTP ${String(this.status)}`;
  }
}

class PeerRosterProtocolError extends Schema.TaggedError<PeerRosterProtocolError>()(
  "PeerRosterProtocolError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

class PeerNotPolledError extends Schema.TaggedError<PeerNotPolledError>()("PeerNotPolledError", {
  label: Schema.String,
}) {
  override get message(): string {
    return `${this.label} has not polled yet`;
  }
}

class PeerSessionMissingError extends Schema.TaggedError<PeerSessionMissingError>()(
  "PeerSessionMissingError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `the session peer ${this.environmentId} held on this server was revoked or has expired; issue it a new credential or remove the peer`;
  }
}

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const remoteAgents = (
  peer: PeerConnection,
  agents: ReadonlyArray<PeerRosterAgent>,
  label: string = peer.label,
): ReadonlyArray<RemoteAgent> =>
  agents.map((entry): RemoteAgent => ({
    environmentId: peer.environmentId,
    environmentLabel: label,
    squadronId: SquadronId.make(entry.squadronId),
    squadronName: entry.squadronName,
    participantId: ParticipantId.make(entry.participantId),
    threadId: entry.threadId,
    displayName: entry.displayName,
    archived: entry.archived,
    canReceiveMessage: entry.canReceiveMessage,
  }));

const readPeerRoster = Effect.fn("j5.a2a.peer.directory.roster")(function* (
  peer: PeerConnection & { readonly origin: string; readonly credential: string },
  peers: PeerRegistryServiceShape,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${peer.origin}${J5_PEER_API_PATHS.roster}`).pipe(
    HttpClientRequest.bearerToken(peer.credential),
    HttpClientRequest.acceptJson,
    HttpClientRequest.setHeaders(peerProtocolHeaders),
  );
  const response = yield* client.execute(request);
  // The peer's row shows a mismatch until a later exchange with it succeeds.
  const mismatch = peerProtocolMismatch({
    stated: statedPeerProtocol(response.headers),
    peer: peer.label,
  });
  if (mismatch !== null) {
    yield* peers.recordLastError(peer.environmentId, mismatch);
    return yield* new PeerRosterProtocolError({ reason: mismatch });
  }
  if (response.status !== 200) {
    return yield* new PeerRosterStatusError({ status: response.status });
  }
  const roster = yield* response.json.pipe(Effect.flatMap(decodeRoster));
  // Only a roster read in full clears it.
  yield* peers.recordLastError(peer.environmentId, null);
  // Each read refreshes the peer's name, so a renamed server is named anew without a re-add.
  const label =
    roster.label === undefined
      ? peer.label
      : ((yield* peers.recordLabel(peer.environmentId, roster.label)) ?? peer.label);
  return remoteAgents(peer, roster.agents, label);
});

/** A peer that no longer holds a session here cannot complete an Exchange with us; it is reported, never read as if healthy. */
const readPeerRosterIfAuthorized = Effect.fn("j5.a2a.peer.directory.rosterIfAuthorized")(function* (
  peer: PeerConnection,
  peers: PeerRegistryServiceShape,
) {
  // A peer this server polls holds no session here by design: this server
  // polls it for what comes back, so only the modes that take deliveries here
  // need one.
  if (peer.linkMode !== "poll" && peer.inboundSession === "missing") {
    return yield* new PeerSessionMissingError({ environmentId: peer.environmentId });
  }
  if (peer.origin === null || peer.credential === null) {
    if (peer.roster === null) return yield* new PeerNotPolledError({ label: peer.label });
    return remoteAgents(peer, peer.roster);
  }
  return yield* readPeerRoster(
    { ...peer, origin: peer.origin, credential: peer.credential },
    peers,
  );
});

export const layer: Layer.Layer<PeerDirectory, never, PeerRegistryService | HttpClient.HttpClient> =
  Layer.effect(
    PeerDirectory,
    Effect.gen(function* () {
      const peers = yield* PeerRegistryService;
      const httpClient = yield* HttpClient.HttpClient;

      const listAgents: PeerDirectoryShape["listAgents"] = () =>
        Effect.gen(function* () {
          const connections = yield* peers.connections();
          const selfName = connections.length === 0 ? null : yield* peers.selfLabel;
          const readings = yield* Effect.forEach(
            connections,
            (peer) =>
              readPeerRosterIfAuthorized(peer, peers).pipe(
                // One bound for the whole read: connect, body, and decode.
                Effect.timeout(PEER_ROSTER_TIMEOUT),
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.map((agents) => ({ agents, unread: null })),
                Effect.catch((cause) =>
                  Effect.succeed({
                    agents: [] as ReadonlyArray<RemoteAgent>,
                    unread: {
                      environmentId: peer.environmentId,
                      label: peer.label,
                      reason: reasonOf(cause),
                    } satisfies UnreadPeer,
                  }),
                ),
              ),
            { concurrency: 4 },
          );
          return {
            agents: readings.flatMap((reading) => reading.agents),
            unreadPeers: readings.flatMap((reading) =>
              reading.unread === null ? [] : [reading.unread],
            ),
            selfName,
          } satisfies PeerDirectoryReading;
        });

      const resolveAgent: PeerDirectoryShape["resolveAgent"] = (participantId) =>
        listAgents().pipe(
          Effect.map((reading) => ({
            ...reading,
            agents: reading.agents.filter((agent) => agent.participantId === participantId),
          })),
        );

      const serverName: PeerDirectoryShape["serverName"] = (environmentId) =>
        peers.get(environmentId).pipe(Effect.map((peer) => peer?.label ?? environmentId));

      const snapshotAgent: PeerDirectoryShape["snapshotAgent"] = (environmentId, participantId) =>
        peers
          .connection(environmentId)
          .pipe(
            Effect.map((peer) =>
              peer === null || peer.roster === null
                ? null
                : (remoteAgents(peer, peer.roster).find(
                    (agent) => agent.participantId === participantId,
                  ) ?? null),
            ),
          );

      return PeerDirectory.of({ listAgents, resolveAgent, snapshotAgent, serverName });
    }),
  );

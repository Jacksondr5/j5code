import type { ThreadId } from "@t3tools/contracts";
import { J5_PEER_API_PATHS, PeerRosterResponse } from "@t3tools/contracts/j5";
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
  type PeerSessionReadError,
} from "./PeerRegistryService.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

/**
 * The address book across peers. Every read asks each peer's roster live:
 * peers are few and a live answer is never stale, and a peer that does not
 * answer is reported as unread rather than guessed at. Agents see the rows by
 * their Squadron; which server a Squadron lives on stays here.
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
}

export type PeerDirectoryError = SqlError | PeerSessionReadError;

export interface PeerDirectoryShape {
  readonly listAgents: () => Effect.Effect<PeerDirectoryReading, PeerDirectoryError>;
  /** The agents with this id across every readable peer; more than one is the caller's ambiguity to refuse. */
  readonly resolveAgent: (
    participantId: ParticipantId,
  ) => Effect.Effect<PeerDirectoryReading, PeerDirectoryError>;
}

export class PeerDirectory extends Context.Service<PeerDirectory, PeerDirectoryShape>()(
  "t3/j5/a2a/PeerDirectory",
) {}

/** No peers: every read is empty and nothing is unread. For layers built without peering. */
export const noneLayer = Layer.succeed(
  PeerDirectory,
  PeerDirectory.of({
    listAgents: () => Effect.succeed({ agents: [], unreadPeers: [] }),
    resolveAgent: () => Effect.succeed({ agents: [], unreadPeers: [] }),
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

class PeerSessionMissingError extends Schema.TaggedError<PeerSessionMissingError>()(
  "PeerSessionMissingError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `the session peer ${this.environmentId} held on this server was revoked or has expired; issue it a new credential or remove the peer`;
  }
}

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const readPeerRoster = Effect.fn("j5.a2a.peer.directory.roster")(function* (peer: PeerConnection) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${peer.origin}${J5_PEER_API_PATHS.roster}`).pipe(
    HttpClientRequest.bearerToken(peer.credential),
    HttpClientRequest.acceptJson,
  );
  const response = yield* client.execute(request);
  if (response.status !== 200) {
    return yield* new PeerRosterStatusError({ status: response.status });
  }
  const roster = yield* response.json.pipe(Effect.flatMap(decodeRoster));
  return roster.agents.map((entry): RemoteAgent => ({
    environmentId: peer.environmentId,
    environmentLabel: peer.label,
    squadronId: SquadronId.make(entry.squadronId),
    squadronName: entry.squadronName,
    participantId: ParticipantId.make(entry.participantId),
    threadId: entry.threadId,
    displayName: entry.displayName,
    archived: entry.archived,
    canReceiveMessage: entry.canReceiveMessage,
  }));
});

/** A peer that no longer holds a session here cannot complete an Exchange with us; it is reported, never read as if healthy. */
const readPeerRosterIfAuthorized = Effect.fn("j5.a2a.peer.directory.rosterIfAuthorized")(function* (
  peer: PeerConnection,
) {
  if (peer.inboundSession === "missing") {
    return yield* new PeerSessionMissingError({ environmentId: peer.environmentId });
  }
  return yield* readPeerRoster(peer);
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
          const readings = yield* Effect.forEach(
            connections,
            (peer) =>
              readPeerRosterIfAuthorized(peer).pipe(
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
          } satisfies PeerDirectoryReading;
        });

      const resolveAgent: PeerDirectoryShape["resolveAgent"] = (participantId) =>
        listAgents().pipe(
          Effect.map((reading) => ({
            agents: reading.agents.filter((agent) => agent.participantId === participantId),
            unreadPeers: reading.unreadPeers,
          })),
        );

      return PeerDirectory.of({ listAgents, resolveAgent });
    }),
  );

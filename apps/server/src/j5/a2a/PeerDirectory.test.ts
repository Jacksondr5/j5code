import { ThreadId } from "@t3tools/contracts";
import { J5_PEER_API_PATHS, type PeerRosterResponse } from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import { PeerDirectory, layer as peerDirectoryLayer } from "./PeerDirectory.ts";
import { PeerRegistryService, type PeerConnection } from "./PeerRegistryService.ts";
import { ParticipantId } from "./contracts.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const homePeer: PeerConnection = {
  environmentId: "environment-home",
  label: "Home",
  linkMode: "push",
  origin: "https://home.example:3773",
  credential: "home-token",
  credentialExpiresAt: null,
  inboundSession: "active",
  createdAt: "2026-09-16T00:00:00.000Z",
  lastPolledAt: null,
  lastError: null,
  waitingCount: 0,
  oldestWaitingAt: null,
  roster: null,
};
const macPeer: PeerConnection = {
  environmentId: "environment-mac",
  label: "Mac",
  linkMode: "push",
  origin: "https://mac.example:3773",
  credential: "mac-token",
  credentialExpiresAt: null,
  inboundSession: "active",
  createdAt: "2026-09-16T00:00:00.000Z",
  lastPolledAt: null,
  lastError: null,
  waitingCount: 0,
  oldestWaitingAt: null,
  roster: null,
};

const homeRoster: PeerRosterResponse = {
  agents: [
    {
      participantId: "agent:j5:a2a:thread:support-triage",
      squadronId: "squadron:home-support",
      squadronName: "L2 Support Rotation",
      displayName: "Support triage",
      threadId: ThreadId.make("thread:support-triage"),
      archived: false,
      canReceiveMessage: true,
    },
    {
      participantId: "agent:j5:a2a:thread:retired",
      squadronId: "squadron:home-support",
      squadronName: "L2 Support Rotation",
      displayName: "Retired",
      threadId: ThreadId.make("thread:retired"),
      archived: true,
      canReceiveMessage: false,
    },
  ],
};

const makeTestLayer = (
  peers: ReadonlyArray<PeerConnection>,
  seen: Array<{ url: string; authorization: string | undefined; protocol?: string | undefined }>,
  /** The protocol header the roster answers state, if any. */
  answeredProtocol?: string,
  /** The name the roster answer reports for its server, and where recorded names go. */
  naming?: { readonly answered: string; readonly recorded: Array<[string, string | undefined]> },
) => {
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        seen.push({
          url: request.url,
          authorization: request.headers.authorization,
          protocol: request.headers["x-j5-peer-protocol"],
        });
        if (request.url.startsWith(macPeer.origin!)) {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "ECONNREFUSED" }),
          });
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            encodeJson(
              naming === undefined ? homeRoster : { ...homeRoster, label: naming.answered },
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                ...(answeredProtocol === undefined
                  ? {}
                  : { "x-j5-peer-protocol": answeredProtocol }),
              },
            },
          ),
        );
      }),
    ),
  );
  const registry = Layer.mock(PeerRegistryService)({
    connections: () => Effect.succeed(peers),
    selfLabel: Effect.succeed("Work VM"),
    recordLastError: () => Effect.void,
    get: (environmentId) =>
      Effect.succeed(peers.find((peer) => peer.environmentId === environmentId) ?? null),
    recordLabel: (environmentId, reported) =>
      Effect.sync(() => {
        naming?.recorded.push([environmentId, reported]);
        return reported ?? null;
      }),
  });
  return peerDirectoryLayer.pipe(Layer.provide(http), Layer.provide(registry));
};

it.effect(
  "lists only agents from readable peers, by Squadron, and names the peers it could not read",
  () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; authorization: string | undefined }> = [];
      const reading = yield* Effect.flatMap(PeerDirectory, (directory) =>
        directory.listAgents(),
      ).pipe(Effect.provide(makeTestLayer([homePeer, macPeer], seen)));
      assert.deepStrictEqual(
        reading.agents.map((agent) => [agent.participantId, agent.squadronName, agent.archived]),
        [
          ["agent:j5:a2a:thread:support-triage", "L2 Support Rotation", false],
          ["agent:j5:a2a:thread:retired", "L2 Support Rotation", true],
        ],
        "the peer route lists agents only, so nothing else can appear",
      );
      assert.equal(reading.agents[0]!.environmentId, "environment-home");
      assert.equal(reading.selfName, "Work VM", "once peered, a reading names this server");
      assert.equal(reading.agents[0]!.displayName, "Support triage");
      assert.equal(reading.unreadPeers.length, 1);
      assert.equal(reading.unreadPeers[0]!.environmentId, "environment-mac");
      assert.equal(reading.unreadPeers[0]!.label, "Mac");
      assert.include(reading.unreadPeers[0]!.reason, "ECONNREFUSED");
      assert.deepStrictEqual(seen.map((request) => request.url).sort(), [
        `${homePeer.origin}${J5_PEER_API_PATHS.roster}`,
        `${macPeer.origin}${J5_PEER_API_PATHS.roster}`,
      ]);
      assert.equal(
        seen.find((request) => request.url.startsWith(homePeer.origin!))?.authorization,
        "Bearer home-token",
      );
    }),
);

it.effect("resolves one participant id to the agents that carry it and nothing else", () =>
  Effect.gen(function* () {
    const directory = yield* PeerDirectory;
    const found = yield* directory.resolveAgent(
      ParticipantId.make("agent:j5:a2a:thread:support-triage"),
    );
    assert.equal(found.agents.length, 1);
    assert.equal(found.agents[0]!.squadronId, "squadron:home-support");
    const missing = yield* directory.resolveAgent(ParticipantId.make("agent:j5:a2a:thread:nobody"));
    assert.deepStrictEqual(missing.agents, []);
    assert.deepStrictEqual(missing.unreadPeers, []);
  }).pipe(Effect.provide(makeTestLayer([homePeer], []))),
);

it.effect("names no server without peers, and names a peer by its recorded name", () =>
  Effect.gen(function* () {
    const lonely = yield* Effect.flatMap(PeerDirectory, (directory) => directory.listAgents()).pipe(
      Effect.provide(makeTestLayer([], [])),
    );
    assert.isNull(lonely.selfName, "a server with no peers names no server");
    const named = yield* Effect.flatMap(PeerDirectory, (directory) =>
      Effect.all([
        directory.serverName(homePeer.environmentId),
        directory.serverName("environment-removed"),
      ]),
    ).pipe(Effect.provide(makeTestLayer([homePeer], [])));
    assert.deepStrictEqual(named, [homePeer.label, "environment-removed"]);
  }),
);

it.effect("reports a peer whose session here is gone as unread, without reading it", () =>
  Effect.gen(function* () {
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const revokedHome: PeerConnection = { ...homePeer, inboundSession: "missing" };
    const reading = yield* Effect.flatMap(PeerDirectory, (directory) =>
      directory.listAgents(),
    ).pipe(Effect.provide(makeTestLayer([revokedHome], seen)));
    assert.deepStrictEqual(reading.agents, []);
    assert.equal(reading.unreadPeers.length, 1);
    assert.equal(reading.unreadPeers[0]!.environmentId, homePeer.environmentId);
    assert.include(reading.unreadPeers[0]!.reason, "revoked or has expired");
    assert.deepStrictEqual(seen, [], "no roster request goes to a peer that cannot answer us back");
  }),
);

it.effect("reads no agents from a peer whose roster answer states another protocol", () =>
  Effect.gen(function* () {
    const seen: Array<{ url: string; authorization: string | undefined; protocol?: string }> = [];
    const reading = yield* Effect.flatMap(PeerDirectory, (directory) =>
      directory.listAgents(),
    ).pipe(Effect.provide(makeTestLayer([homePeer], seen, "2")));
    assert.deepStrictEqual(reading.agents, [], "a roster read on another protocol is not trusted");
    assert.deepStrictEqual(reading.unreadPeers, [
      {
        environmentId: homePeer.environmentId,
        label: "Home",
        reason:
          "Home runs peer protocol 2 and this server runs 1. Update J5 on this server, then try again.",
      },
    ]);
    assert.equal(seen[0]!.protocol, "1", "the read states this server's protocol");

    const matching = yield* Effect.flatMap(PeerDirectory, (directory) =>
      directory.listAgents(),
    ).pipe(Effect.provide(makeTestLayer([homePeer], [], "1")));
    assert.equal(matching.agents.length, 2, "a peer that states the same version is read");
  }),
);

it.effect("refreshes a peer's name from each roster read, so a renamed server is named anew", () =>
  Effect.gen(function* () {
    const recorded: Array<[string, string | undefined]> = [];
    const reading = yield* Effect.flatMap(PeerDirectory, (directory) =>
      directory.listAgents(),
    ).pipe(
      Effect.provide(makeTestLayer([homePeer], [], undefined, { answered: "Home Mac", recorded })),
    );
    assert.deepStrictEqual(recorded, [["environment-home", "Home Mac"]]);
    assert.deepStrictEqual(
      [...new Set(reading.agents.map((agent) => agent.environmentLabel))],
      ["Home Mac"],
      "the rows carry the name the peer just reported",
    );
  }),
);

it.effect(
  "keeps a protocol mismatch on the peer's record until a roster read succeeds in full",
  () =>
    Effect.gen(function* () {
      const lastErrors: Array<string | null> = [];
      const answers: Array<{ readonly status: number; readonly protocol: string }> = [
        { status: 200, protocol: "2" },
        { status: 500, protocol: "1" },
        { status: 200, protocol: "1" },
      ];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const answer = answers.shift()!;
            return HttpClientResponse.fromWeb(
              request,
              new Response(encodeJson(homeRoster), {
                status: answer.status,
                headers: {
                  "content-type": "application/json",
                  "x-j5-peer-protocol": answer.protocol,
                },
              }),
            );
          }),
        ),
      );
      const registry = Layer.mock(PeerRegistryService)({
        connections: () => Effect.succeed([homePeer]),
        selfLabel: Effect.succeed("Work VM"),
        recordLastError: (_environmentId, error) =>
          Effect.sync(() => {
            lastErrors.push(error);
          }),
      });
      yield* Effect.gen(function* () {
        const directory = yield* PeerDirectory;
        yield* directory.listAgents();
        assert.equal(lastErrors.length, 1);
        assert.include(lastErrors[0] ?? "", "runs peer protocol 2");
        // The same version answers, but with an error: the request failed, so the mismatch stands.
        const failed = yield* directory.listAgents();
        assert.equal(failed.unreadPeers.length, 1);
        assert.equal(lastErrors.length, 1, "a failed read clears nothing");
        const read = yield* directory.listAgents();
        assert.equal(read.agents.length, 2);
        assert.deepStrictEqual(lastErrors.at(-1), null, "a full read clears it");
      }).pipe(
        Effect.provide(peerDirectoryLayer.pipe(Layer.provide(http), Layer.provide(registry))),
      );
    }),
);

it.effect("reads a peer this server polls live, though that peer holds no session here", () =>
  Effect.gen(function* () {
    // This server polls the VM, so the VM never presents a credential here.
    const polled: PeerConnection = { ...homePeer, linkMode: "poll", inboundSession: "missing" };
    const reading = yield* Effect.flatMap(PeerDirectory, (directory) =>
      directory.listAgents(),
    ).pipe(Effect.provide(makeTestLayer([polled], [])));
    assert.equal(reading.agents.length, 2);
    assert.deepStrictEqual(reading.unreadPeers, []);
  }),
);

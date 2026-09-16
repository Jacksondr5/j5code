import { ThreadId } from "@t3tools/contracts";
import { J5_MACHINE_API_PATHS, type A2ARosterResponse } from "@t3tools/contracts/j5";
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
  origin: "https://home.example:3773",
  credential: "home-token",
  createdAt: "2026-09-16T00:00:00.000Z",
};
const macPeer: PeerConnection = {
  environmentId: "environment-mac",
  label: "Mac",
  origin: "https://mac.example:3773",
  credential: "mac-token",
  createdAt: "2026-09-16T00:00:00.000Z",
};

const homeRoster: A2ARosterResponse = {
  participants: [
    {
      participantId: "agent:j5:a2a:thread:support-triage",
      kind: "agent",
      squadronId: "squadron:home-support",
      squadronName: "L2 Support Rotation",
      displayName: "Support triage",
      threadId: ThreadId.make("thread:support-triage"),
      archived: false,
      canReceiveMessage: true,
      acceptsUrgency: false,
      liveness: null,
    },
    {
      participantId: "agent:j5:a2a:thread:retired",
      kind: "agent",
      squadronId: "squadron:home-support",
      squadronName: "L2 Support Rotation",
      displayName: "Retired",
      threadId: ThreadId.make("thread:retired"),
      archived: true,
      canReceiveMessage: false,
      acceptsUrgency: false,
      liveness: null,
    },
    {
      participantId: "human:home-person",
      kind: "human",
      squadronId: null,
      squadronName: null,
      displayName: null,
      threadId: null,
      archived: false,
      canReceiveMessage: false,
      acceptsUrgency: true,
      liveness: null,
    },
    {
      participantId: "machine:watchdog",
      kind: "machine",
      squadronId: "squadron:home-support",
      squadronName: "L2 Support Rotation",
      displayName: "watchdog",
      threadId: null,
      archived: false,
      canReceiveMessage: false,
      acceptsUrgency: false,
      liveness: null,
    },
  ],
};

const makeTestLayer = (
  peers: ReadonlyArray<PeerConnection>,
  seen: Array<{ url: string; authorization: string | undefined }>,
) => {
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        seen.push({ url: request.url, authorization: request.headers.authorization });
        if (request.url.startsWith(macPeer.origin)) {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "ECONNREFUSED" }),
          });
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson(homeRoster), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
  const registry = Layer.mock(PeerRegistryService)({ connections: () => Effect.succeed(peers) });
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
        "people and machines on a peer are never listed",
      );
      assert.equal(reading.agents[0]!.environmentId, "environment-home");
      assert.equal(reading.agents[0]!.displayName, "Support triage");
      assert.equal(reading.unreadPeers.length, 1);
      assert.equal(reading.unreadPeers[0]!.environmentId, "environment-mac");
      assert.equal(reading.unreadPeers[0]!.label, "Mac");
      assert.include(reading.unreadPeers[0]!.reason, "ECONNREFUSED");
      assert.deepStrictEqual(seen.map((request) => request.url).sort(), [
        `${homePeer.origin}${J5_MACHINE_API_PATHS.roster}`,
        `${macPeer.origin}${J5_MACHINE_API_PATHS.roster}`,
      ]);
      assert.equal(
        seen.find((request) => request.url.startsWith(homePeer.origin))?.authorization,
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

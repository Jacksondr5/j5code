import { AuthA2APeerScope, AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import {
  J5_PEER_API_PATHS,
  PEER_SENDER_LABEL_MAX_CHARS,
  type PeerHelloResponse,
} from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerRegistryService, layer as peerRegistryLayer } from "./PeerRegistryService.ts";

const timestamp = "2026-09-16T12:00:00.000Z";
const work = EnvironmentId.make("environment-work");
const home = EnvironmentId.make("environment-home");
const homeOrigin = "https://home.example:3773";
const homeExpiry = "2036-09-16T12:00:00.000Z";

interface SeenRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly protocol: string | undefined;
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type HelloReply =
  | {
      readonly status: 200;
      readonly body: PeerHelloResponse;
      readonly headers?: Record<string, string>;
    }
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  | { readonly unreachable: string }
  | { readonly stall: true };

/** A stub of the peer side: every origin answers its hello route by the table, everything else is unreachable. */
const makeTestLayer = (input: {
  readonly replies: Record<string, HelloReply>;
  readonly seen?: Array<SeenRequest>;
  readonly ourEnvironmentId?: EnvironmentId;
  /** Subjects that currently hold a live session on this server. */
  readonly liveSubjects?: ReadonlyArray<string>;
}) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        input.seen?.push({
          url: request.url,
          authorization: request.headers.authorization,
          protocol: request.headers["x-j5-peer-protocol"],
        });
        const origin = request.url.replace(J5_PEER_API_PATHS.hello, "");
        const reply = input.replies[origin];
        if (reply === undefined || "unreachable" in reply) {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: reply === undefined ? "ECONNREFUSED" : reply.unreachable,
            }),
          });
        }
        if ("stall" in reply) {
          // Headers arrive, the body never does: the exchange must still end at the bound.
          return HttpClientResponse.fromWeb(
            request,
            new Response(new ReadableStream({ start: () => {} }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.body === undefined ? null : encodeJson(reply.body), {
            status: reply.status,
            headers: { "content-type": "application/json", ...reply.headers },
          }),
        );
      }),
    ),
  );
  const identity = Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(input.ourEnvironmentId ?? work),
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    listSessions: () =>
      Effect.succeed(
        (input.liveSubjects ?? []).map((subject, index) => ({
          sessionId: AuthSessionId.make(`auth-session:${String(index)}`),
          subject,
          scopes: [AuthA2APeerScope],
          method: "bearer-access-token" as const,
          client: { deviceType: "bot" as const },
          issuedAt: DateTime.makeUnsafe(timestamp),
          expiresAt: DateTime.makeUnsafe(homeExpiry),
          lastConnectedAt: null,
          connected: false,
          current: false,
        })),
      ),
  });
  const registry = peerRegistryLayer.pipe(
    Layer.provide(database),
    Layer.provide(http),
    Layer.provide(identity),
    Layer.provide(auth),
  );
  return Layer.mergeAll(database, registry);
};

const homeHello = (subject: string, label: string | null = "Home"): HelloReply => ({
  status: 200,
  body: {
    environmentId: home,
    subject,
    credentialExpiresAt: homeExpiry,
    server: { version: "0.0.0-test" },
    ...(label === null ? {} : { label }),
  },
});

it.effect(
  "records a peer only after its hello names this environment, then rotates on re-add",
  () =>
    Effect.gen(function* () {
      const seen: Array<SeenRequest> = [];
      const replies: Record<string, HelloReply> = { [homeOrigin]: homeHello(`peer:${work}`) };
      yield* Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const registry = yield* PeerRegistryService;

        const first = yield* registry.add({
          origin: homeOrigin,
          credential: "home-issued-token",
          replaceOrigin: false,
          acceptedAt: timestamp,
        });
        assert.isTrue(first.created);
        assert.deepStrictEqual(first.peer, {
          environmentId: home,
          label: "Home",
          linkMode: "push",
          origin: homeOrigin,
          credentialExpiresAt: homeExpiry,
          inboundSession: "active",
          createdAt: timestamp,
          lastPolledAt: null,
          lastError: null,
          waitingCount: 0,
          oldestWaitingAt: null,
        });
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.url, `${homeOrigin}${J5_PEER_API_PATHS.hello}`);
        assert.equal(seen[0]!.authorization, "Bearer home-issued-token");
        assert.equal(seen[0]!.protocol, "1", "hello states this server's peer protocol");

        // Home renamed its machine: the next hello carries its new name.
        replies[homeOrigin] = homeHello(`peer:${work}`, "Home Mac");
        const again = yield* registry.add({
          origin: homeOrigin,
          credential: "home-issued-token-2",
          replaceOrigin: false,
          acceptedAt: "2026-09-17T00:00:00.000Z",
        });
        assert.isFalse(again.created);
        assert.equal(again.peer.createdAt, timestamp);
        assert.equal(again.peer.label, "Home Mac", "the peer's own name replaces the recorded one");

        // A server from before names says none; the recorded name stands.
        replies[homeOrigin] = homeHello(`peer:${work}`, null);
        const unnamed = yield* registry.add({
          origin: homeOrigin,
          credential: "home-issued-token-3",
          replaceOrigin: false,
          acceptedAt: "2026-09-17T00:00:00.000Z",
        });
        assert.equal(unnamed.peer.label, "Home Mac");

        // A peer-supplied name is bounded like any other.
        replies[homeOrigin] = homeHello(`peer:${work}`, "H".repeat(500));
        const long = yield* registry.add({
          origin: homeOrigin,
          credential: "home-issued-token-4",
          replaceOrigin: false,
          acceptedAt: "2026-09-17T00:00:00.000Z",
        });
        assert.equal(long.peer.label, "H".repeat(PEER_SENDER_LABEL_MAX_CHARS));

        // A roster read reports the name too; only a change is written.
        assert.equal(yield* registry.recordLabel(home, "  Home Studio  "), "Home Studio");
        assert.equal((yield* registry.get(home))?.label, "Home Studio");
        assert.equal(
          yield* registry.recordLabel(home, undefined),
          "Home Studio",
          "an answer without a name keeps the recorded one",
        );
        assert.isNull(yield* registry.recordLabel("environment-unknown", "Nobody"));

        assert.deepStrictEqual(
          (yield* registry.list()).map((peer) => peer.environmentId),
          [home],
        );
        assert.deepStrictEqual((yield* registry.get(home))?.origin, homeOrigin);
        assert.deepStrictEqual(yield* registry.remove(home), { removed: true });
        assert.deepStrictEqual(yield* registry.remove(home), { removed: false });
        assert.deepStrictEqual(yield* registry.list(), []);
        assert.isNull(yield* registry.get(home));
      }).pipe(Effect.provide(makeTestLayer({ replies, seen, liveSubjects: [`peer:${home}`] })));
    }),
);

it.effect("keeps a known peer's origin unless the caller says to move it", () =>
  Effect.gen(function* () {
    const movedOrigin = "https://home-moved.example:3773";
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const registry = yield* PeerRegistryService;
      yield* registry.add({
        origin: homeOrigin,
        credential: "t1",
        replaceOrigin: false,
        acceptedAt: timestamp,
      });
      const refused = yield* Effect.flip(
        registry.add({
          origin: movedOrigin,
          credential: "t2",
          replaceOrigin: false,
          acceptedAt: timestamp,
        }),
      );
      assert.equal(refused._tag, "PeerOriginConflictError");
      assert.include(refused.message, homeOrigin);
      assert.equal((yield* registry.get(home))?.origin, homeOrigin, "nothing moved");
      // Both addresses reach Home: the hello retired t1, and the recorded origin accepts t2, so t2 is kept.
      assert.isTrue(refused._tag === "PeerOriginConflictError" && refused.credentialKept);
      const stored = yield* (yield* SqlClient.SqlClient)<{ readonly credential: string }>`
        SELECT credential FROM j5_a2a_peer WHERE environment_id = ${home}
      `;
      assert.deepStrictEqual(stored, [{ credential: "t2" }]);
      assert.equal((yield* registry.get(home))?.label, "Home");

      const moved = yield* registry.add({
        origin: movedOrigin,
        credential: "t2",
        replaceOrigin: true,
        acceptedAt: timestamp,
      });
      assert.isFalse(moved.created);
      assert.equal(moved.peer.origin, movedOrigin);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          replies: {
            [homeOrigin]: homeHello(`peer:${work}`),
            [movedOrigin]: homeHello(`peer:${work}`),
          },
          liveSubjects: [`peer:${home}`],
        }),
      ),
    );
  }),
);

it.effect("keeps the recorded credential when a different server claims the same peer", () =>
  Effect.gen(function* () {
    const impostorOrigin = "https://copy-of-home.example:3773";
    const replies: Record<string, HelloReply> = {
      [homeOrigin]: homeHello(`peer:${work}`),
      [impostorOrigin]: homeHello(`peer:${work}`),
    };
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const registry = yield* PeerRegistryService;
      yield* registry.add({
        origin: homeOrigin,
        credential: "t1",
        replaceOrigin: false,
        acceptedAt: timestamp,
      });
      // A copied environment answers with Home's id, but Home itself does not accept its credential.
      replies[homeOrigin] = { status: 401, body: { error: "invalid_token" } };
      const refused = yield* Effect.flip(
        registry.add({
          origin: impostorOrigin,
          credential: "t2",
          replaceOrigin: false,
          acceptedAt: timestamp,
        }),
      );
      assert.equal(refused._tag, "PeerOriginConflictError");
      assert.isTrue(refused._tag === "PeerOriginConflictError" && !refused.credentialKept);
      assert.include(refused.message, "not accepted");
      const stored = yield* (yield* SqlClient.SqlClient)<{ readonly credential: string }>`
        SELECT credential FROM j5_a2a_peer WHERE environment_id = ${home}
      `;
      assert.deepStrictEqual(stored, [{ credential: "t1" }], "the working credential survives");
    }).pipe(Effect.provide(makeTestLayer({ replies, liveSubjects: [`peer:${home}`] })));
  }),
);

it.effect(
  "reports a peer whose session here was revoked or expired as missing, never healthy",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const registry = yield* PeerRegistryService;
      const added = yield* registry.add({
        origin: homeOrigin,
        credential: "t",
        replaceOrigin: false,
        acceptedAt: timestamp,
      });
      assert.equal(added.peer.inboundSession, "missing");
      assert.equal((yield* registry.list())[0]?.inboundSession, "missing");
    }).pipe(
      Effect.provide(
        makeTestLayer({ replies: { [homeOrigin]: homeHello(`peer:${work}`) }, liveSubjects: [] }),
      ),
    ),
);

it.effect(
  "refuses an unreachable origin, a stalled body, a rejected credential, a foreign credential, and itself",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const registry = yield* PeerRegistryService;
      const attempt = (origin: string) =>
        Effect.flip(
          registry.add({
            origin,
            credential: "token",
            replaceOrigin: false,
            acceptedAt: timestamp,
          }),
        );

      assert.equal((yield* attempt("https://dark.example"))._tag, "PeerUnreachableError");
      assert.equal((yield* attempt("https://not-j5.example"))._tag, "PeerUnreachableError");
      // Headers arrive and the body never does; the bound, not the body, ends it.
      const stalling = yield* Effect.forkChild(attempt("https://stall.example"));
      yield* TestClock.adjust("6 seconds");
      const stalled = yield* Fiber.join(stalling);
      assert.equal(stalled._tag, "PeerUnreachableError");
      assert.include(stalled.message, "no complete hello answer");
      assert.equal((yield* attempt("https://revoked.example"))._tag, "PeerCredentialRejectedError");
      const mismatch = yield* attempt("https://other.example");
      assert.equal(mismatch._tag, "PeerCredentialMismatchError");
      assert.include(mismatch.message, "peer:environment-elsewhere");
      assert.equal((yield* attempt("https://self.example"))._tag, "PeerIsSelfError");
      assert.deepStrictEqual(yield* registry.list(), [], "nothing refused is recorded");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          replies: {
            "https://dark.example": { unreachable: "ECONNREFUSED" },
            "https://not-j5.example": { status: 404 },
            "https://stall.example": { stall: true },
            "https://revoked.example": { status: 401, body: { error: "invalid_token" } },
            "https://other.example": homeHello("peer:environment-elsewhere"),
            "https://self.example": {
              status: 200,
              body: { environmentId: work, subject: `peer:${work}`, server: { version: "0" } },
            },
          },
        }),
      ),
    ),
);

it.effect(
  "hands the transport every recorded peer with its session status, never dropping a revoked one",
  () =>
    Effect.gen(function* () {
      const add = Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const registry = yield* PeerRegistryService;
        yield* registry.add({
          origin: homeOrigin,
          credential: "home-issued-token",
          replaceOrigin: false,
          acceptedAt: timestamp,
        });
        return registry;
      });
      yield* Effect.gen(function* () {
        const registry = yield* add;
        const revoked = yield* registry.connections();
        assert.equal(
          revoked.length,
          1,
          "revoked in Settings: still listed, so a caller can say why",
        );
        assert.equal(revoked[0]!.inboundSession, "missing");
        assert.equal((yield* registry.connection(home))?.inboundSession, "missing");
      }).pipe(
        Effect.provide(
          makeTestLayer({ replies: { [homeOrigin]: homeHello(`peer:${work}`) }, liveSubjects: [] }),
        ),
      );
      yield* Effect.gen(function* () {
        const registry = yield* add;
        const live = yield* registry.connection(home);
        assert.equal(live?.inboundSession, "active");
        assert.equal(live?.credential, "home-issued-token");
        assert.isNull(yield* registry.connection("environment-unknown"));
      }).pipe(
        Effect.provide(
          makeTestLayer({
            replies: { [homeOrigin]: homeHello(`peer:${work}`) },
            liveSubjects: [`peer:${home}`],
          }),
        ),
      );
    }),
);

it.effect(
  "counts a hello without a protocol version as version 1, ignores unknown fields, and refuses a mismatch",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const registry = yield* PeerRegistryService;
      const attempt = (origin: string) =>
        registry.add({
          origin,
          credential: "token",
          replaceOrigin: false,
          acceptedAt: timestamp,
        });

      // A server from the first peering stack says nothing about versions.
      assert.isTrue((yield* attempt(homeOrigin)).created);
      // A newer server at the same version adds fields this one does not know.
      assert.isTrue((yield* attempt("https://newer-fields.example")).created);

      // A body that states another version is refused even when no header says so.
      const bodyOnly = yield* Effect.flip(attempt("https://newer-body.example"));
      assert.equal(bodyOnly._tag, "PeerProtocolMismatchError");
      assert.include(bodyOnly.message, "runs peer protocol 2 and this server runs 1");

      const newer = yield* Effect.flip(attempt("https://newer.example"));
      assert.equal(newer._tag, "PeerProtocolMismatchError");
      assert.equal(
        newer.message,
        "The server at https://newer.example runs peer protocol 2 and this server runs 1. Update J5 on this server, then try again.",
      );
      assert.deepStrictEqual(
        (yield* registry.list()).map((peer) => peer.environmentId),
        [home, "environment-fields"],
        "a mismatch records nothing",
      );
    }).pipe(
      Effect.provide(
        makeTestLayer({
          replies: {
            [homeOrigin]: homeHello(`peer:${work}`),
            "https://newer-fields.example": {
              status: 200,
              headers: { "x-j5-peer-protocol": "1" },
              body: {
                environmentId: "environment-fields",
                subject: `peer:${work}`,
                server: { version: "0.0.99" },
                peerProtocolVersion: 1,
                capabilities: { poll: true, somethingLater: true },
                somethingElse: { nested: true },
              },
            },
            "https://newer-body.example": {
              status: 200,
              body: {
                environmentId: "environment-newer-body",
                subject: `peer:${work}`,
                server: { version: "0.1.0" },
                peerProtocolVersion: 2,
              },
            },
            "https://newer.example": {
              status: 200,
              body: {
                environmentId: "environment-newer",
                subject: `peer:${work}`,
                server: { version: "0.1.0" },
                peerProtocolVersion: 2,
              },
              headers: { "x-j5-peer-protocol": "2" },
            },
          },
        }),
      ),
    ),
);

it.effect(
  "records a polling peer only when it first presents the credential issued for it as store",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const registry = yield* PeerRegistryService;
      const laptop = "environment-laptop";
      yield* registry.grantStore({
        environmentId: laptop,
        sessionId: "auth-session:laptop-store",
        issuedAt: timestamp,
      });
      assert.deepStrictEqual(yield* registry.list(), [], "an unused credential records nothing");

      const otherSession = yield* registry.adoptStorePeer({
        environmentId: laptop,
        sessionId: "auth-session:something-else",
        at: timestamp,
      });
      assert.isFalse(otherSession, "only the session issued as store is proof");

      assert.isTrue(
        yield* registry.adoptStorePeer({
          environmentId: laptop,
          sessionId: "auth-session:laptop-store",
          at: "2026-10-02T12:00:00.000Z",
        }),
      );
      const recorded = yield* registry.get(laptop);
      assert.equal(recorded?.linkMode, "store");
      assert.isNull(recorded?.origin ?? null, "this server never connects to a peer that polls it");
      assert.equal(recorded?.label, laptop, "named by its id until its first poll");
      assert.equal(recorded?.createdAt, "2026-10-02T12:00:00.000Z");
      // Later proofs find the record; the grant is spent.
      assert.isTrue(
        yield* registry.adoptStorePeer({
          environmentId: laptop,
          sessionId: "auth-session:something-else",
          at: timestamp,
        }),
      );

      const polled = yield* registry.recordPoll({
        environmentId: laptop,
        receivedAt: "2026-10-02T12:01:00.000Z",
        protocolVersion: 1,
        label: "JM-LT-04213",
        capabilities: {},
        roster: undefined,
      });
      assert.isNull(polled.rosterHash, "no snapshot until the poller sends one");
      const named = yield* registry.get(laptop);
      assert.equal(named?.label, "JM-LT-04213");
      assert.equal(named?.lastPolledAt, "2026-10-02T12:01:00.000Z", "its arrival is the heartbeat");

      // Adding it as a peer to send to directly would change its mode, which needs a removal first.
      const conflict = yield* Effect.flip(
        registry.add({
          origin: "https://laptop.example",
          credential: "laptop-token",
          replaceOrigin: false,
          acceptedAt: timestamp,
        }),
      );
      assert.equal(conflict._tag, "PeerLinkModeConflictError");

      assert.deepStrictEqual(yield* registry.remove(laptop), { removed: true });
      assert.isFalse(
        yield* registry.adoptStorePeer({
          environmentId: laptop,
          sessionId: "auth-session:laptop-store",
          at: timestamp,
        }),
        "peering again starts empty",
      );
    }).pipe(
      Effect.provide(
        makeTestLayer({
          replies: {
            "https://laptop.example": {
              status: 200,
              body: {
                environmentId: "environment-laptop",
                subject: `peer:${work}`,
                server: { version: "0.0.0-test" },
              },
            },
          },
        }),
      ),
    ),
);

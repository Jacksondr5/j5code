import { AuthA2APeerScope, AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import { J5_PEER_API_PATHS, type PeerHelloResponse } from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

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
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type HelloReply =
  | { readonly status: 200; readonly body: PeerHelloResponse }
  | { readonly status: number; readonly body?: unknown }
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
  const database = NodeSqliteClient.layerMemory();
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        input.seen?.push({ url: request.url, authorization: request.headers.authorization });
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
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
  const identity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
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

const homeHello = (subject: string): HelloReply => ({
  status: 200,
  body: {
    environmentId: home,
    subject,
    credentialExpiresAt: homeExpiry,
    server: { version: "0.0.0-test" },
  },
});

it.effect(
  "records a peer only after its hello names this environment, then rotates on re-add",
  () =>
    Effect.gen(function* () {
      const seen: Array<SeenRequest> = [];
      yield* Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const registry = yield* PeerRegistryService;

        const first = yield* registry.add({
          origin: homeOrigin,
          credential: "home-issued-token",
          label: "Home",
          replaceOrigin: false,
          acceptedAt: timestamp,
        });
        assert.isTrue(first.created);
        assert.deepStrictEqual(first.peer, {
          environmentId: home,
          label: "Home",
          origin: homeOrigin,
          credentialExpiresAt: homeExpiry,
          inboundSession: "active",
          createdAt: timestamp,
        });
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.url, `${homeOrigin}${J5_PEER_API_PATHS.hello}`);
        assert.equal(seen[0]!.authorization, "Bearer home-issued-token");

        const again = yield* registry.add({
          origin: homeOrigin,
          credential: "home-issued-token-2",
          label: undefined,
          replaceOrigin: false,
          acceptedAt: "2026-09-17T00:00:00.000Z",
        });
        assert.isFalse(again.created);
        assert.equal(again.peer.createdAt, timestamp);
        assert.equal(again.peer.label, home, "a blank label falls back to the environment id");

        assert.deepStrictEqual(
          (yield* registry.list()).map((peer) => peer.environmentId),
          [home],
        );
        assert.deepStrictEqual((yield* registry.get(home))?.origin, homeOrigin);
        assert.deepStrictEqual(yield* registry.remove(home), { removed: true });
        assert.deepStrictEqual(yield* registry.remove(home), { removed: false });
        assert.deepStrictEqual(yield* registry.list(), []);
        assert.isNull(yield* registry.get(home));
      }).pipe(
        Effect.provide(
          makeTestLayer({
            replies: { [homeOrigin]: homeHello(`peer:${work}`) },
            seen,
            liveSubjects: [`peer:${home}`],
          }),
        ),
      );
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
        label: "Home",
        replaceOrigin: false,
        acceptedAt: timestamp,
      });
      const refused = yield* Effect.flip(
        registry.add({
          origin: movedOrigin,
          credential: "t2",
          label: "Home",
          replaceOrigin: false,
          acceptedAt: timestamp,
        }),
      );
      assert.equal(refused._tag, "PeerOriginConflictError");
      assert.include(refused.message, homeOrigin);
      assert.equal((yield* registry.get(home))?.origin, homeOrigin, "nothing moved");

      const moved = yield* registry.add({
        origin: movedOrigin,
        credential: "t2",
        label: "Home",
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

it.effect(
  "reports a peer whose session here was revoked or expired as missing, never healthy",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const registry = yield* PeerRegistryService;
      const added = yield* registry.add({
        origin: homeOrigin,
        credential: "t",
        label: "Home",
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
            label: undefined,
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

import { AuthA2APeerScope, AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import { J5_PEER_API_PATHS, type PeerHelloResponse } from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerRegistryService, layer as peerRegistryLayer } from "./PeerRegistryService.ts";

const timestamp = "2026-09-16T12:00:00.000Z";
const work = EnvironmentId.make("environment-work");
const home = EnvironmentId.make("environment-home");
const homeOrigin = "https://home.example:3773";

interface SeenRequest {
  readonly url: string;
  readonly authorization: string | undefined;
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type HelloReply =
  | { readonly status: 200; readonly body: PeerHelloResponse }
  | { readonly status: number; readonly body?: unknown }
  | { readonly unreachable: string };

/** A stub of the peer side: every origin answers its hello route by the table, everything else is unreachable. */
/** The peer sessions this server still holds; a revoked one is simply absent. */
const liveSubjects: Array<string> = [];

const makeTestLayer = (
  replies: Record<string, HelloReply>,
  seen: Array<SeenRequest> = [],
  ourEnvironmentId: EnvironmentId = work,
) => {
  const database = NodeSqliteClient.layerMemory();
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        seen.push({ url: request.url, authorization: request.headers.authorization });
        const origin = request.url.replace(J5_PEER_API_PATHS.hello, "");
        const reply = replies[origin];
        if (reply === undefined || "unreachable" in reply) {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: reply === undefined ? "ECONNREFUSED" : reply.unreachable,
            }),
          });
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
    getEnvironmentId: Effect.succeed(ourEnvironmentId),
  });
  const auth = Layer.mock(EnvironmentAuth)({
    listSessions: () =>
      Effect.succeed(
        liveSubjects.map((subject, index) => ({
          sessionId: AuthSessionId.make(`auth-session:${String(index)}`),
          subject,
          scopes: [AuthA2APeerScope],
          method: "bearer-access-token" as const,
          client: { deviceType: "bot" as const },
          issuedAt: DateTime.makeUnsafe("2026-09-01T00:00:00.000Z"),
          expiresAt: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"),
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

const seen: Array<SeenRequest> = [];

const homeHello = (subject: string): HelloReply => ({
  status: 200,
  body: { environmentId: home, subject, server: { version: "0.0.0-test" } },
});

it.effect(
  "records a peer only after its hello names this environment, then rotates on re-add",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const registry = yield* PeerRegistryService;

      const first = yield* registry.add({
        origin: homeOrigin,
        credential: "home-issued-token",
        label: "Home",
        acceptedAt: timestamp,
      });
      assert.isTrue(first.created);
      assert.deepStrictEqual(first.peer, {
        environmentId: home,
        label: "Home",
        origin: homeOrigin,
        createdAt: timestamp,
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.url, `${homeOrigin}${J5_PEER_API_PATHS.hello}`);
      assert.equal(seen[0]!.authorization, "Bearer home-issued-token");

      const again = yield* registry.add({
        origin: homeOrigin,
        credential: "home-issued-token-2",
        label: undefined,
        acceptedAt: "2026-09-17T00:00:00.000Z",
      });
      assert.isFalse(again.created);
      assert.equal(again.peer.createdAt, timestamp);
      assert.equal(again.peer.label, home, "a blank label falls back to the environment id");

      assert.deepStrictEqual(
        (yield* registry.list()).map((peer) => peer.environmentId),
        [home],
      );
      assert.deepStrictEqual(yield* registry.remove(home), { removed: true });
      assert.deepStrictEqual(yield* registry.remove(home), { removed: false });
      assert.deepStrictEqual(yield* registry.list(), []);
    }).pipe(Effect.provide(makeTestLayer({ [homeOrigin]: homeHello(`peer:${work}`) }, seen))),
);

it.effect(
  "refuses an unreachable origin, a rejected credential, a foreign credential, and itself",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const registry = yield* PeerRegistryService;
      const attempt = (origin: string) =>
        Effect.flip(
          registry.add({ origin, credential: "token", label: undefined, acceptedAt: timestamp }),
        );

      assert.equal((yield* attempt("https://dark.example"))._tag, "PeerUnreachableError");
      assert.equal((yield* attempt("https://not-j5.example"))._tag, "PeerUnreachableError");
      assert.equal((yield* attempt("https://revoked.example"))._tag, "PeerCredentialRejectedError");
      const mismatch = yield* attempt("https://other.example");
      assert.equal(mismatch._tag, "PeerCredentialMismatchError");
      assert.include(mismatch.message, "peer:environment-elsewhere");
      assert.equal((yield* attempt("https://self.example"))._tag, "PeerIsSelfError");
      assert.deepStrictEqual(yield* registry.list(), [], "nothing refused is recorded");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          "https://dark.example": { unreachable: "ECONNREFUSED" },
          "https://not-j5.example": { status: 404 },
          "https://revoked.example": { status: 401, body: { error: "invalid_token" } },
          "https://other.example": homeHello("peer:environment-elsewhere"),
          "https://self.example": {
            status: 200,
            body: { environmentId: work, subject: `peer:${work}`, server: { version: "0" } },
          },
        }),
      ),
    ),
);

it.effect("hands a peer to the transport only while the session it holds here is still live", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const registry = yield* PeerRegistryService;
    yield* registry.add({
      origin: homeOrigin,
      credential: "home-issued-token",
      label: "Home",
      acceptedAt: timestamp,
    });
    liveSubjects.length = 0;
    assert.deepStrictEqual(yield* registry.connections(), [], "revoked in Settings: no delivery");
    assert.equal((yield* registry.list()).length, 1, "the record itself stays visible");
    liveSubjects.push(`peer:${home}`);
    const live = yield* registry.connections();
    assert.equal(live.length, 1);
    assert.equal(live[0]!.credential, "home-issued-token");
    liveSubjects.length = 0;
  }).pipe(Effect.provide(makeTestLayer({ [homeOrigin]: homeHello(`peer:${work}`) }))),
);

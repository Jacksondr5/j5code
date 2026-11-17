// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { J5_PEER_API_PATHS } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { holdLine } from "./LineClient.ts";
import {
  layer as lineRegistryLayer,
  layerRoutingHttpClient,
  LineRegistry,
} from "./LineRegistry.ts";

const LAPTOP = "environment:laptop";
const LINE_HOST = "127.77.0.1";

/**
 * The storing server: the line route, minus the peer checks `PeerHttp.test.ts` covers, served on a
 * real socket so it can upgrade. `ended` stands for the peer's session ending here.
 */
const storingServer = (ended: Deferred.Deferred<void>) =>
  HttpRouter.add(
    "GET",
    J5_PEER_API_PATHS.line,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.authorization !== "Bearer good") {
        return HttpServerResponse.empty({ status: 401 });
      }
      const socket = yield* request.upgrade;
      const lines = yield* LineRegistry;
      return yield* lines.serve({
        environmentId: LAPTOP,
        host: LINE_HOST,
        socket,
        ended: Deferred.await(ended),
      });
    }).pipe(Effect.orDie),
  );

/** The poller's own server: it answers with the Host and path it was asked for. */
const pollerServer = Effect.acquireRelease(
  Effect.promise(async () => {
    const server = NodeHttp.createServer((req, res) => res.end(`${req.headers.host} ${req.url}`));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
  }),
  (server) =>
    Effect.promise(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
);

const setup = Effect.gen(function* () {
  const ended = yield* Deferred.make<void>();
  const registry = yield* Layer.build(lineRegistryLayer);
  const served = yield* Layer.build(
    HttpRouter.serve(storingServer(ended), { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(Layer.succeedContext(registry)),
    ),
  );
  const routed = yield* Layer.build(
    layerRoutingHttpClient.pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeedContext(registry)),
    ),
  );
  const poller = yield* pollerServer;
  const lines = Context.get(registry, LineRegistry);
  return {
    ended,
    lines,
    client: Context.get(routed, HttpClient.HttpClient),
    origin: HttpServer.formatAddress(Context.get(served, HttpServer.HttpServer).address),
    local: { host: "127.0.0.1", port: (poller.address() as NodeNet.AddressInfo).port },
  };
});

const get = (client: HttpClient.HttpClient, url: string) =>
  client.get(url).pipe(Effect.flatMap((response) => response.text));

it.effect("reaches the poller through its line, and every other address as before", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const line = yield* setup;
      const ups = yield* line.lines.subscribeUps;
      yield* holdLine({ origin: line.origin, credential: "good", local: line.local }).pipe(
        Effect.forkScoped,
      );
      yield* Stream.runHead(ups);

      assert.strictEqual(
        yield* get(line.client, `http://${LINE_HOST}:1/hello`),
        `${LINE_HOST}:1 /hello`,
      );
      const direct = `127.0.0.1:${String(line.local.port)}`;
      assert.strictEqual(yield* get(line.client, `http://${direct}/direct`), `${direct} /direct`);
    }),
  ),
);

it.effect("fails a call at once when no line is up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const line = yield* setup;
      const failed = yield* Effect.flip(get(line.client, `http://${LINE_HOST}:1/hello`));
      assert.strictEqual(failed._tag, "HttpClientError");
    }),
  ),
);

it.effect("closes the line when the peer's session ends, and calls fail after", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const line = yield* setup;
      const ups = yield* line.lines.subscribeUps;
      const held = yield* holdLine({
        origin: line.origin,
        credential: "good",
        local: line.local,
      }).pipe(Effect.forkScoped);
      yield* Stream.runHead(ups);
      yield* Deferred.succeed(line.ended, undefined);
      const ended = yield* Fiber.join(held);
      assert.strictEqual(ended.kind, "closed");
      yield* Effect.flip(get(line.client, `http://${LINE_HOST}:1/hello`));
    }),
  ),
);

it.effect("lets a newer line replace the old one, without the old one's close taking it down", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const line = yield* setup;
      const ups = yield* line.lines.subscribeUps;
      const firstUp = yield* Stream.take(ups, 2).pipe(Stream.runCollect, Effect.forkScoped);
      const first = yield* holdLine({
        origin: line.origin,
        credential: "good",
        local: line.local,
      }).pipe(Effect.forkScoped);
      const second = yield* holdLine({
        origin: line.origin,
        credential: "good",
        local: line.local,
      }).pipe(Effect.forkScoped);
      yield* Fiber.join(firstUp);
      // One of the two connected second and replaced the other, whose line then ended.
      const ended = yield* Fiber.join(
        yield* Effect.raceFirst(
          Fiber.await(first).pipe(Effect.as(first)),
          Fiber.await(second).pipe(Effect.as(second)),
        ),
      );
      assert.strictEqual(ended.kind, "closed");
      assert.strictEqual(
        yield* get(line.client, `http://${LINE_HOST}:1/still`),
        `${LINE_HOST}:1 /still`,
      );
    }),
  ),
);

it.effect("stops when the storing server refuses the credential", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const line = yield* setup;
      const ended = yield* holdLine({
        origin: line.origin,
        credential: "revoked",
        local: line.local,
      });
      assert.strictEqual(ended.kind, "rejected");
    }),
  ),
);

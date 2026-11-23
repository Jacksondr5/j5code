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
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import WebSocket from "ws";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { holdLine, keepLineUp, type LineEnd } from "./LineClient.ts";
import {
  layer as lineRegistryLayer,
  layerRoutingHttpClient,
  LineRegistry,
} from "./LineRegistry.ts";

const LAPTOP = "environment:laptop";
const LINE_HOST = "127.77.0.1";

/**
 * The storing server: the line route, minus the peer checks `PeerHttp.test.ts` covers, served on a
 * real socket so it can upgrade. `ended` holds the signal for the peer's session ending here; each
 * line served awaits the one current when it opened.
 */
const storingServer = (ended: Ref.Ref<Deferred.Deferred<void>>) =>
  HttpRouter.add(
    "GET",
    J5_PEER_API_PATHS.line,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.authorization !== "Bearer good") {
        return HttpServerResponse.empty({ status: 401 });
      }
      // Read before the line is up, so a session ended after its up event is this line's.
      const session = yield* Ref.get(ended);
      const socket = yield* request.upgrade;
      const lines = yield* LineRegistry;
      return yield* lines.serve({
        environmentId: LAPTOP,
        host: LINE_HOST,
        socket,
        ended: Deferred.await(session),
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
  const ended = yield* Ref.make(yield* Deferred.make<void>());
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
    /** Ends the peer's session for the line up now; a later line gets a session of its own. */
    endSession: Effect.gen(function* () {
      const current = yield* Ref.get(ended);
      yield* Ref.set(ended, yield* Deferred.make<void>());
      yield* Deferred.succeed(current, undefined);
    }),
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
      yield* line.endSession;
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

it.effect("fails calls at once when the poller's side of the line drops", () =>
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
      assert.strictEqual(
        yield* get(line.client, `http://${LINE_HOST}:1/before`),
        `${LINE_HOST}:1 /before`,
      );
      // The laptop goes away without a word, as across a sleep or a dropped network.
      yield* Fiber.interrupt(held);
      yield* Effect.flip(get(line.client, `http://${LINE_HOST}:1/after`));
    }),
  ),
);

it.effect("closes a line that goes quiet, and calls fail after", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const line = yield* setup;
      const ups = yield* line.lines.subscribeUps;
      // A poller that opens the line and then says nothing at all.
      yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new WebSocket(`${line.origin.replace(/^http/, "ws")}${J5_PEER_API_PATHS.line}`, {
              headers: { authorization: "Bearer good" },
            }),
        ),
        (socket) => Effect.sync(() => socket.terminate()),
      );
      yield* Stream.runHead(ups);
      yield* TestClock.adjust("30 seconds");
      yield* Effect.flip(get(line.client, `http://${LINE_HOST}:1/after`));
    }),
  ),
);

it.effect("opens a new line as soon as the old one closes, without waiting for a poll", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const line = yield* setup;
      const ups = yield* Queue.unbounded<string>();
      yield* (yield* line.lines.subscribeUps).pipe(
        Stream.runForEach((up) => Queue.offer(ups, up.lineId)),
        Effect.forkScoped,
      );
      const endings = yield* Queue.unbounded<LineEnd>();
      yield* keepLineUp({
        origin: line.origin,
        credential: "good",
        local: line.local,
        onEnd: (ended) => Queue.offer(endings, ended).pipe(Effect.asVoid),
      }).pipe(Effect.forkScoped);
      const first = yield* Queue.take(ups);
      yield* line.endSession;
      assert.deepInclude(yield* Queue.take(endings), { kind: "closed", opened: true });
      yield* TestClock.adjust("1 second");
      const second = yield* Queue.take(ups);
      assert.notStrictEqual(second, first);
      assert.strictEqual(
        yield* get(line.client, `http://${LINE_HOST}:1/again`),
        `${LINE_HOST}:1 /again`,
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

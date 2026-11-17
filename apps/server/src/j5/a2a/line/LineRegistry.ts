// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { HttpClient, HttpServerResponse } from "effect/http";
import { NodeHttpClient } from "@effect/platform-node";

import { isLineHost } from "./lineAddress.ts";
import { encodeFrame, FrameType, LineClosedError, LineMux, type LineStream } from "./LineMux.ts";

/** How often each side of a line says it is there, and how many quiet periods end the line. */
export const LINE_PING_INTERVAL = "10 seconds";
export const LINE_QUIET_PERIODS = 3;
/** A stream holding more unread bytes than this is reset rather than buffered further. */
export const LINE_MAX_UNREAD_BYTES = 32 * 1024 * 1024;

interface CurrentLine {
  readonly lineId: string;
  readonly environmentId: string;
  readonly mux: LineMux;
  /** Completed when a newer line from the same peer replaces this one. */
  readonly replaced: Deferred.Deferred<void>;
}

export interface LineRegistryShape {
  /**
   * Serves one line a peer that polls this server opened, reached at `host`, until it closes, its
   * session ends, or it goes quiet. A new line from the same peer replaces this one.
   */
  readonly serve: (input: {
    readonly environmentId: string;
    readonly host: string;
    readonly socket: Socket.Socket;
    /** Completes when the peer's session here is revoked, expires, or its peer record is removed. */
    readonly ended: Effect.Effect<void>;
  }) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  /**
   * A stream to the peer behind a line host, or why there is none. Node's HTTP client calls it to
   * make each connection, so it answers at once.
   */
  readonly connect: (host: string) => LineStream | LineClosedError;
  /** The id of the line a peer holds here now, or null when none is up. */
  readonly currentLineId: (environmentId: string) => string | null;
  /** Each line as it comes up, from the moment of subscribing. */
  readonly subscribeUps: Effect.Effect<Stream.Stream<LineUp>, never, Scope.Scope>;
}

export interface LineUp {
  readonly environmentId: string;
  readonly lineId: string;
}

export class LineRegistry extends Context.Service<LineRegistry, LineRegistryShape>()(
  "t3/j5/a2a/line/LineRegistry",
) {}

const pingFrame = encodeFrame(FrameType.ping, 0);

const make = Effect.gen(function* () {
  const byHost = new Map<string, CurrentLine>();
  const ups = yield* PubSub.unbounded<LineUp>();

  const connect: LineRegistryShape["connect"] = (host) => {
    const line = byHost.get(host);
    if (line === undefined) {
      return new LineClosedError(`No line is up to the server at ${host}.`);
    }
    try {
      return line.mux.open();
    } catch (error) {
      return error instanceof LineClosedError ? error : new LineClosedError(String(error));
    }
  };

  const serve: LineRegistryShape["serve"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* input.socket.reader;
        const writer = yield* input.socket.writer;
        // Effect's writer hands each frame to `ws` and returns; it never waits on the socket. So
        // frames go out in order from one queue, and the poller bounds what it sends this way.
        const outbound = yield* Queue.unbounded<Uint8Array>();
        const mux = new LineMux({
          send: (frame, sent) => {
            Queue.offerUnsafe(outbound, frame);
            sent();
          },
          maxUnreadBytes: LINE_MAX_UNREAD_BYTES,
        });
        const line: CurrentLine = {
          lineId: NodeCrypto.randomUUID(),
          environmentId: input.environmentId,
          mux,
          replaced: yield* Deferred.make<void>(),
        };
        const previous = byHost.get(input.host);
        if (previous !== undefined) {
          previous.mux.close(new LineClosedError("A newer line replaced this one."));
          Deferred.doneUnsafe(previous.replaced, Effect.void);
        }
        byHost.set(input.host, line);
        yield* PubSub.publish(ups, { environmentId: line.environmentId, lineId: line.lineId });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            // A late close of a replaced line must not take down its replacement.
            if (byHost.get(input.host) === line) byHost.delete(input.host);
            mux.close(new LineClosedError(`The line to ${input.environmentId} closed.`));
          }),
        );

        let quiet = 0;
        const readLoop = Effect.forever(
          Effect.flatMap(reader.pull, (chunks) =>
            Effect.sync(() => {
              quiet = 0;
              for (const chunk of chunks) if (typeof chunk !== "string") mux.receive(chunk);
            }),
          ),
        );
        const writeLoop = Effect.forever(
          Effect.flatMap(Queue.take(outbound), (frame) => writer.write(frame)),
        );
        const pingLoop = Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(LINE_PING_INTERVAL);
            quiet += 1;
            if (quiet >= LINE_QUIET_PERIODS) {
              return yield* Effect.fail(new LineClosedError("The line went quiet."));
            }
            Queue.offerUnsafe(outbound, pingFrame);
          }),
        );
        // Whichever ends first ends the line, a failure included: a dropped or quiet socket fails.
        yield* Effect.raceAllFirst([
          readLoop,
          writeLoop,
          pingLoop,
          input.ended,
          Deferred.await(line.replaced),
        ]).pipe(Effect.ignoreCause);
        yield* writer.write(new Socket.CloseEvent(1000, "line closed")).pipe(Effect.ignoreCause);
        return HttpServerResponse.empty();
      }),
    ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty()));

  const currentLineId: LineRegistryShape["currentLineId"] = (environmentId) => {
    for (const line of byHost.values()) {
      if (line.environmentId === environmentId) return line.lineId;
    }
    return null;
  };

  return LineRegistry.of({
    serve,
    connect,
    currentLineId,
    subscribeUps: Effect.map(PubSub.subscribe(ups), Stream.fromSubscription),
  });
});

export const layer = Layer.effect(LineRegistry, make);

/**
 * Node's HTTP agent for line hosts: each connection is a stream over the peer's line. No keep-alive,
 * since this server's `/mcp` closes its connection after each response anyway.
 */
class LineAgent extends NodeHttp.Agent {
  readonly #lines: LineRegistryShape;

  constructor(lines: LineRegistryShape) {
    super({ keepAlive: false });
    this.#lines = lines;
  }

  override createConnection(options: NodeHttp.ClientRequestArgs): NodeStream.Duplex {
    const stream = this.#lines.connect(String(options.host ?? options.hostname ?? ""));
    if (!(stream instanceof LineClosedError)) return stream;
    // The request fails with this as its socket's error; a throw here would escape the client.
    const failed = new NodeStream.PassThrough();
    process.nextTick(() => failed.destroy(stream));
    return failed;
  }
}

/**
 * The HTTP client upstream's link services get: a line host goes through its line, every other
 * address through the client given, in the caller's context so its fetch options still apply.
 */
export const layerRoutingHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const inner = yield* HttpClient.HttpClient;
    const lines = yield* LineRegistry;
    const agent = yield* Effect.acquireRelease(
      Effect.sync(() => new LineAgent(lines)),
      (created) => Effect.sync(() => created.destroy()),
    );
    const lineClient = yield* NodeHttpClient.makeNodeHttp.pipe(
      Effect.provideService(NodeHttpClient.HttpAgent, {
        http: agent,
        https: NodeHttps.globalAgent,
      }),
    );
    return HttpClient.make((request, url) =>
      isLineHost(url.hostname) ? lineClient.execute(request) : inner.execute(request),
    );
  }),
);

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";

import { J5_PEER_API_PATHS } from "@t3tools/contracts/j5";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import WebSocket from "ws";

import { peerProtocolHeaders } from "../peerProtocol.ts";
import { LINE_MAX_UNREAD_BYTES, LINE_PING_INTERVAL, LINE_QUIET_PERIODS } from "./LineRegistry.ts";
import { encodeFrame, FrameType, LineClosedError, LineMux, type LineStream } from "./LineMux.ts";

/**
 * How a line ended: closed after it was up or while dialling, refused before it opened, or rejected
 * because this server's credential is no longer accepted.
 */
export type LineEnd =
  | { readonly kind: "closed"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string };

const pingFrame = encodeFrame(FrameType.ping, 0);

/** Where this server answers itself: its own host, or loopback when it listens on every interface. */
export const localTarget = (config: {
  readonly host: string | undefined;
  readonly port: number;
}) => ({
  host:
    config.host === undefined ||
    config.host === "" ||
    config.host === "0.0.0.0" ||
    config.host === "::"
      ? "127.0.0.1"
      : config.host,
  port: config.port,
});

/** Joins a stream from the line to a new connection to this server, both ways, ending or failing together. */
const connectLocal = (
  stream: LineStream,
  target: { readonly host: string; readonly port: number },
) => {
  const socket = NodeNet.connect(target);
  socket.on("error", (error) => stream.destroy(error));
  stream.on("error", () => socket.destroy());
  stream.pipe(socket);
  socket.pipe(stream);
};

/**
 * Holds one line from this server, which polls `origin`, to the server there, until it closes. The
 * server at `origin` reaches this one through it: each stream it opens becomes a connection to
 * this server's own address. Each send waits for `ws` to hand its frame to the socket, so a large
 * answer is read from this server only as fast as the line carries it.
 */
export const holdLine = Effect.fn("j5.a2a.peer.line.hold")(function* (input: {
  readonly origin: string;
  readonly credential: string;
  readonly local: { readonly host: string; readonly port: number };
}) {
  const ended = yield* Deferred.make<LineEnd>();
  const end = (outcome: LineEnd) => Deferred.doneUnsafe(ended, Effect.succeed(outcome));
  const url = new URL(J5_PEER_API_PATHS.line, input.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new WebSocket(url, {
              headers: { authorization: `Bearer ${input.credential}`, ...peerProtocolHeaders },
              perMessageDeflate: false,
            }),
        ),
        (ws) => Effect.sync(() => ws.terminate()),
      );
      const mux = new LineMux({
        send: (frame, sent) => {
          if (socket.readyState !== WebSocket.OPEN) {
            sent(new LineClosedError("The line is not open."));
            return;
          }
          socket.send(frame, { binary: true }, (error) => sent(error ?? null));
        },
        onOpen: (stream) => connectLocal(stream, input.local),
        maxUnreadBytes: LINE_MAX_UNREAD_BYTES,
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => mux.close(new LineClosedError("The line closed."))),
      );

      let quiet = 0;
      socket.on("message", (data, isBinary) => {
        quiet = 0;
        if (!isBinary) return;
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        mux.receive(bytes);
      });
      socket.on("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        end(
          status === 401
            ? {
                kind: "rejected",
                reason: "The server this one polls no longer accepts its credential.",
              }
            : { kind: "refused", reason: `The line was refused with HTTP ${String(status)}.` },
        );
      });
      socket.on("close", (code, reason) =>
        end({
          kind: "closed",
          reason: `The line closed (${String(code)} ${reason.toString()}).`.trim(),
        }),
      );
      socket.on("error", (error) => end({ kind: "closed", reason: error.message }));

      const ping = Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(LINE_PING_INTERVAL);
          quiet += 1;
          if (quiet >= LINE_QUIET_PERIODS) {
            end({ kind: "closed", reason: "The line went quiet." });
          } else if (socket.readyState === WebSocket.OPEN) {
            socket.send(pingFrame, { binary: true });
          }
        }),
      );
      return yield* Effect.raceFirst(Deferred.await(ended), ping);
    }),
  );
});

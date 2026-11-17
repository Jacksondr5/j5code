// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";

import { decodeFrame, FrameType, LineClosedError, LineMux, type LineStream } from "./LineMux.ts";

/**
 * The storing server's mux and the poller's, joined in memory. The poller's side connects each
 * stream to `target`, as the line client does; the storing server's side is what Node's HTTP
 * client gets as its socket, through `agent`.
 */
const pair = async (
  handler: NodeHttp.RequestListener,
  options: { readonly maxUnreadBytes?: number } = {},
) => {
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as NodeNet.AddressInfo).port;
  const sentByStoring: Array<number> = [];
  let poller: LineMux | null = null;
  const storing = new LineMux({
    send: (frame, sent) => {
      sentByStoring.push(frame[0]!);
      queueMicrotask(() => poller?.receive(frame));
      sent();
    },
    maxUnreadBytes: options.maxUnreadBytes ?? 32 * 1024 * 1024,
  });
  poller = new LineMux({
    send: (frame, sent) => {
      queueMicrotask(() => {
        storing.receive(frame);
        sent();
      });
    },
    onOpen: (stream) => {
      const socket = NodeNet.connect({ host: "127.0.0.1", port });
      socket.on("error", (error) => stream.destroy(error));
      stream.on("error", () => socket.destroy());
      stream.pipe(socket);
      socket.pipe(stream);
    },
    maxUnreadBytes: 32 * 1024 * 1024,
  });
  class Agent extends NodeHttp.Agent {
    override createConnection(): LineStream {
      return storing.open();
    }
  }
  const agent = new Agent({ keepAlive: false });
  const request = (path: string, signal?: AbortSignal) =>
    new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
      const req = NodeHttp.request(
        { host: "127.77.0.1", port: 1, path, agent, ...(signal === undefined ? {} : { signal }) },
        (res) => {
          const chunks: Array<Buffer> = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  return {
    storing,
    request,
    sentByStoring,
    [Symbol.asyncDispose]: async () => {
      storing.close(new LineClosedError("test over"));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

describe("LineMux", () => {
  it("carries an HTTP exchange, keeping the line host as the request's Host", async () => {
    await using line = await pair((req, res) => res.end(`${req.headers.host} ${req.url}`));
    const answer = await line.request("/.well-known/t3/environment");
    expect(answer).toEqual({ status: 200, body: "127.77.0.1:1 /.well-known/t3/environment" });
    // Both directions ended cleanly, so the storing side sent no reset.
    expect(line.sentByStoring).not.toContain(FrameType.reset);
  });

  it("answers a small request while a 5 MB answer is still crossing", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    await using line = await pair((req, res) => res.end(req.url === "/big" ? big : "small"));
    const [large, small] = await Promise.all([line.request("/big"), line.request("/small")]);
    expect(large.body.length).toBe(big.length);
    expect(small.body).toBe("small");
  });

  it("fails a response cut after its headers", async () => {
    await using line = await pair((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      res.socket?.destroy();
    });
    await expect(line.request("/cut")).rejects.toThrow();
  });

  it("fails every open exchange when the line closes, and opens nothing after", async () => {
    const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
    await using line = await pair(() => arrive());
    const waiting = line.request("/wait");
    await arrived;
    line.storing.close(new LineClosedError("The line went quiet."));
    await expect(waiting).rejects.toThrow("The line went quiet.");
    expect(() => line.storing.open()).toThrow(LineClosedError);
  });

  it("resets only the exchange that was aborted", async () => {
    const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
    await using line = await pair((req, res) => {
      if (req.url === "/wait") arrive();
      else res.end("still here");
    });
    const abort = new AbortController();
    const waiting = line.request("/wait", abort.signal);
    await arrived;
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect(line.sentByStoring).toContain(FrameType.reset);
    expect((await line.request("/other")).body).toBe("still here");
  });

  it("resets a stream whose reader falls too far behind, instead of buffering more", async () => {
    const sent: Array<Uint8Array> = [];
    const mux = new LineMux({
      send: (frame, done) => (sent.push(frame), done()),
      maxUnreadBytes: 8,
    });
    const stream = mux.open();
    const failure = new Promise<Error>((resolve) => stream.once("error", resolve));
    const id = decodeFrame(sent[0]!)!.id;
    const data = new Uint8Array([FrameType.data, 0, 0, 0, id, ...new Array(16).fill(65)]);
    mux.receive(data);
    expect(stream.destroyed).toBe(true);
    expect(sent.map((frame) => frame[0])).toContain(FrameType.reset);
    expect((await failure).message).toBe("The line stream's reader fell too far behind.");
  });
});

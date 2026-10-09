// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { configureMcpHttpConnections } from "./mcpHttpConnections.ts";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

async function setup(handler: NodeHttp.RequestListener) {
  const server = configureMcpHttpConnections(NodeHttp.createServer());
  server.on("request", handler);
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
  const agent = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
  cleanups.push(() => agent.destroy());
  const request = (path: string, headers: NodeHttp.OutgoingHttpHeaders = {}) =>
    new Promise<{ body: string; headers: NodeHttp.IncomingHttpHeaders }>((resolve, reject) => {
      const request = NodeHttp.request(
        { host: "127.0.0.1", port, path, method: "POST", agent, headers },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => resolve({ body, headers: response.headers }));
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end();
    });
  return { server, request };
}

describe("MCP HTTP connections", () => {
  it("keeps a logical MCP session across fresh connections without repeating a POST", async () => {
    const sockets: NodeNet.Socket[] = [];
    const firstClosed = Promise.withResolvers<void>();
    let calls = 0;
    const { request } = await setup((req, res) => {
      sockets.push(req.socket);
      calls += 1;
      if (calls === 1) {
        req.socket.once("close", firstClosed.resolve);
        res.setHeader("mcp-session-id", "test-session");
      } else {
        expect(req.headers["mcp-session-id"]).toBe("test-session");
      }
      res.end("ok");
    });

    const initialized = await request("/mcp");
    expect(initialized.headers.connection).toBe("close");
    await firstClosed.promise;
    const called = await request("/mcp?client=provider", {
      "mcp-session-id": initialized.headers["mcp-session-id"],
    });
    expect(called.body).toBe("ok");
    expect(called.headers.connection).toBe("close");
    expect(sockets[1]).not.toBe(sockets[0]);
    expect(calls).toBe(2);
  });

  it("preserves keep-alive for other HTTP routes", async () => {
    const sockets: NodeNet.Socket[] = [];
    const { request } = await setup((req, res) => {
      sockets.push(req.socket);
      res.end("ok");
    });
    for (const path of ["/api/test", "/mcp-other", "/api/test"]) {
      expect((await request(path)).headers.connection).toBe("keep-alive");
    }
    expect(new Set(sockets).size).toBe(1);
  });

  it("lets a streaming tool response finish before closing its connection", async () => {
    const started = Promise.withResolvers<NodeHttp.ServerResponse>();
    const { request } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: progress\n\n");
      started.resolve(res);
    });
    const result = request("/mcp");
    const response = await started.promise;
    expect(response.destroyed).toBe(false);
    response.end("data: complete\n\n");
    expect((await result).body).toBe("data: progress\n\ndata: complete\n\n");
  });
});

// @effect-diagnostics nodeBuiltinImport:off
/**
 * A fake `t3-code` MCP server: real tool names, descriptions and schemas from source, results
 * from the case's mocks. One server per run; each sample has its own path, `/mcp/<sampleId>`.
 * It answers streamable-HTTP JSON-RPC with plain JSON responses and never opens a stream.
 * `/hook/<sampleId>` serves the sample's Codex PreToolUse hook, which runs as a separate process.
 */
import * as NodeHttp from "node:http";

import { type Catalog, type Sample, t3McpTools, t3Result } from "./upstream.ts";

export type McpSample = {
  readonly sample: Sample;
  readonly codex: boolean;
  readonly effort: string;
  readonly catalog: Catalog;
  /** Every T3 call the server answered, in order. */
  readonly answered: Array<{ readonly tool: string; readonly input: unknown }>;
  /** The hook's reply for one PreToolUse input. */
  hook?: (input: Readonly<Record<string, unknown>>) => Promise<unknown>;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const startMcpServer = async () => {
  const samples = new Map<string, McpSample>();
  const server = NodeHttp.createServer((request, response) => {
    const [, kind, id = ""] = /^\/(mcp|hook)\/([\w-]+)/.exec(request.url ?? "") ?? [];
    const entry = samples.get(id);
    if (request.method !== "POST" || entry === undefined) {
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (kind === "hook") {
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        void (entry.hook?.(input) ?? Promise.resolve({})).then((reply) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(reply));
        });
        return;
      }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number | string;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const reply = (result: unknown) => {
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": id });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      switch (message.method) {
        case "initialize":
          return reply({
            protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "t3-code", version: "eval" },
          });
        case "tools/list":
          return reply({ tools: t3McpTools(entry.sample.testCase, entry.catalog) });
        case "tools/call": {
          const name = String(message.params?.name ?? "");
          const input = isRecord(message.params?.arguments) ? message.params.arguments : {};
          entry.answered.push({ tool: name, input });
          void t3Result(entry.sample, name, input, entry).then(({ value, isError }) => {
            const text = typeof value === "string" ? value : JSON.stringify(value);
            reply({ content: [{ type: "text", text }], isError });
          });
          return;
        }
        default:
          return reply({});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    register: (id: string, entry: McpSample) => {
      samples.set(id, entry);
      return `http://127.0.0.1:${port}/mcp/${id}`;
    },
    hookUrl: (id: string) => `http://127.0.0.1:${port}/hook/${id}`,
    close: () => server.close(),
  };
};

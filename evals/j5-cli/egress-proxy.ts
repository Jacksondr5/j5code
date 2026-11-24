#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
/**
 * The eval container's only way out: an HTTPS CONNECT proxy that admits the model providers'
 * hosts and refuses everything else. Every decision is logged, so a run shows what it reached.
 */
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

const allowed = (process.env.EGRESS_ALLOW ?? "").split(",").filter(Boolean);
const port = Number(process.env.EGRESS_PORT ?? 3128);
const admits = (host: string) =>
  allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
const log = (decision: string, host: string) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), decision, host }));

const server = NodeHttp.createServer((request, response) => {
  log("refused-plain-http", request.headers.host ?? "");
  response.writeHead(403).end("Only HTTPS to the model providers leaves this network.\n");
});
server.on("connect", (request, client, head) => {
  const [host = "", portText = "443"] = (request.url ?? "").split(":");
  if (!admits(host) || portText !== "443") {
    log("refused", `${host}:${portText}`);
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  log("allowed", host);
  const upstream = NodeNet.connect(443, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    client.destroy();
  };
  upstream.on("error", close);
  client.on("error", close);
});
server.listen(port, () => log("listening", `${allowed.join(",")} on ${port}`));

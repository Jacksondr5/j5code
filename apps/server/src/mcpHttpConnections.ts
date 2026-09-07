// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";

/**
 * Finish MCP responses by closing their HTTP connection. Provider clients can
 * race Node's idle keep-alive timeout when reusing a socket for the next tool
 * call. A failed POST cannot be retried safely after a tool may have run.
 * MCP sessions live above HTTP connections; streaming responses stay open
 * until they finish, and the next request opens a fresh connection.
 */
export function configureMcpHttpConnections<T extends NodeHttp.Server>(server: T): T {
  server.on("request", (request, response) => {
    if (request.url?.split("?", 1)[0] === "/mcp") {
      response.shouldKeepAlive = false;
    }
  });
  return server;
}

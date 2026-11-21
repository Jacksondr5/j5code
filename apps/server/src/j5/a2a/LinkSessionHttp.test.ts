import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import { J5_LINK_SESSION_API_PATH } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { linkSessionHttpRouteLayer } from "./LinkSessionHttp.ts";
import { layer as linkSessionLayer } from "./LinkSessionService.ts";
import LinkSessionsMigration from "./migrations/059_LinkSessions.ts";

/** Each token is one live session here; `peerLink` says whether a linked environment holds it. */
const tokens: Record<string, { readonly sessionId: string; readonly peerLink: boolean }> = {
  "home-first": { sessionId: "auth-session:home-first", peerLink: true },
  "home-renewed": { sessionId: "auth-session:home-renewed", peerLink: true },
  mac: { sessionId: "auth-session:mac", peerLink: true },
  "outside-agent": { sessionId: "auth-session:outside-agent", peerLink: false },
};

/** `failOnce` holds session ids whose next revocation the auth store fails. */
const makeHandler = (revoked: Array<string>, failOnce = new Set<string>()) => {
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateMcpClient: (request) => {
      const session = tokens[request.headers.authorization?.replace("Bearer ", "") ?? ""];
      return session === undefined || revoked.includes(session.sessionId)
        ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({}))
        : Effect.succeed({
            sessionId: AuthSessionId.make(session.sessionId),
            label: "J5 Code · Home",
            access: "approval-required" as const,
            peerLink: session.peerLink,
          });
    },
    revokeSession: (sessionId) =>
      failOnce.delete(sessionId)
        ? Effect.fail(new EnvironmentAuth.ServerAuthSessionRevocationError({ cause: "store down" }))
        : Effect.sync(() => {
            if (revoked.includes(sessionId)) return false;
            revoked.push(sessionId);
            return true;
          }),
  });
  const routes = Layer.merge(
    linkSessionHttpRouteLayer,
    Layer.effectDiscard(LinkSessionsMigration),
  ).pipe(
    Layer.provide(linkSessionLayer),
    Layer.provide(auth),
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, { disableLogger: true });
};

const call = (method: "PUT" | "DELETE", token: string, body?: unknown) =>
  new Request(`http://environment.test${J5_LINK_SESSION_API_PATH}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

it("lets a link's own token say which server holds it and revoke itself, and nothing else", async () => {
  const revoked: Array<string> = [];
  const failOnce = new Set(["auth-session:home-first"]);
  const { dispose, handler } = makeHandler(revoked, failOnce);
  try {
    assert.equal(
      (await handler(call("PUT", "home-first", { environmentId: "environment-home" }))).status,
      204,
    );
    assert.equal(
      (await handler(call("PUT", "mac", { environmentId: "environment-mac" }))).status,
      204,
    );
    assert.deepStrictEqual(revoked, [], "a first claim ends nothing");

    assert.equal(
      (await handler(call("PUT", "home-renewed", { environmentId: "environment-home" }))).status,
      500,
      "the replaced session could not be revoked",
    );
    assert.deepStrictEqual(revoked, []);
    // The replaced session is still on record, so the same claim revokes it once the store works.
    assert.equal(
      (await handler(call("PUT", "home-renewed", { environmentId: "environment-home" }))).status,
      204,
    );
    assert.deepStrictEqual(
      revoked,
      ["auth-session:home-first"],
      "a server holds one link here, so the session of the link it replaced is revoked",
    );

    assert.equal((await handler(call("DELETE", "mac"))).status, 204);
    assert.deepStrictEqual(revoked, ["auth-session:home-first", "auth-session:mac"]);

    assert.equal((await handler(call("PUT", "home-renewed", {}))).status, 400);
    assert.equal(
      (await handler(call("PUT", "outside-agent", { environmentId: "environment-home" }))).status,
      403,
      "an outside agent's session is not a link's",
    );
    assert.equal((await handler(call("DELETE", "outside-agent"))).status, 403);
    assert.equal((await handler(call("DELETE", "mac"))).status, 401, "a revoked token is refused");
    assert.equal((await handler(call("DELETE", "unknown"))).status, 401);
    assert.deepStrictEqual(revoked, ["auth-session:home-first", "auth-session:mac"]);
  } finally {
    await dispose();
  }
});

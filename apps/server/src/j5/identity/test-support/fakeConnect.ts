// @effect-diagnostics nodeBuiltinImport:off - the fake signs ID tokens and checks PKCE with Node's crypto.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * A J5 Connect in-process, behind an `HttpClient`: discovery, keys, an authorization endpoint that
 * knows its client's return addresses, and a token endpoint for codes and refreshes. Its refusal
 * of a disabled account and its outage answer alike, HTTP 500 `invalid_request`, as Dex's do.
 * Everything in it is invented.
 */

export const ISSUER = "https://connect.example.test";
export const CLIENT_ID = "j5-test-server";
/** A second client registered for the same server, with the same secret and return addresses. */
export const OTHER_CLIENT_ID = "j5-test-server-renamed";
const CLIENT_IDS = new Set([CLIENT_ID, OTHER_CLIENT_ID]);
export const CLIENT_SECRET = "invented-client-secret";

interface User {
  readonly email: string;
  readonly name: string;
  active: boolean;
  /** Whether J5 Connect says the email is verified; it does unless told otherwise. */
  readonly emailVerified?: boolean;
}

interface Code {
  readonly subject: string;
  readonly nonce: string;
  readonly returnUrl: string;
  readonly challenge: string;
}

/** A point a request waits at: `entered` when it gets there, and it goes on once `release` is done. */
export interface Gate {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

export const makeGate = Effect.gen(function* () {
  return {
    entered: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
  } satisfies Gate;
});

export interface FakeConnectShape {
  readonly client: HttpClient.HttpClient;
  readonly returnUrls: Set<string>;
  readonly users: Map<string, User>;
  /** While set, every request fails as if J5 Connect could not be reached at all. */
  down: boolean;
  /** While set, every token request answers as Dex does when its identity provider is down. */
  outage: boolean;
  /** Refreshes of these accounts never answer; `stalled` completes when one starts. */
  readonly stall: Set<string>;
  stalled: Deferred.Deferred<void> | null;
  /** A refresh answers 200 with no ID token. */
  refreshWithoutIdToken: boolean;
  /** A sign-in comes back with no refresh token, as when the connector lacks `offline_access`. */
  withoutOfflineAccess: boolean;
  /** Discovery names its token endpoint over plain HTTP: to an outside name, or to loopback. */
  plainHttpEndpoint: "outside" | "loopback" | null;
  /** Discovery answers with this status and no configuration, as a broken J5 Connect does. */
  discoveryStatus: number | null;
  /** Every refresh answers with this status and no tokens, as a proxy in front of it might. */
  refreshStatus: number | null;
  /** The token endpoint takes any code at all. */
  takesAnyCode: boolean;
  /** The next code exchange waits at this gate. */
  codeGate: Gate | null;
  /** Overrides on the next ID token's claims, to make one that must not be trusted. */
  nextClaims: Record<string, unknown> | null;
  /** Signs `subject` in at an authorization URL the server made; returns the code sent back. */
  readonly signIn: (authorizationUrl: string, subject: string) => string;
}

export class FakeConnect extends Context.Service<FakeConnect, FakeConnectShape>()(
  "t3/j5/identity/test-support/fakeConnect",
) {}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const make = Effect.promise(async () => {
  const keys = await NodeCrypto.webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await NodeCrypto.webcrypto.subtle.exportKey("jwk", keys.publicKey);
  const codes = new Map<string, Code>();
  const refreshTokens = new Map<string, string>();
  const random = () => NodeCrypto.randomBytes(16).toString("base64url");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  const fake: FakeConnectShape = {
    client: undefined as never,
    returnUrls: new Set(),
    users: new Map(),
    down: false,
    outage: false,
    stall: new Set(),
    stalled: null,
    refreshWithoutIdToken: false,
    withoutOfflineAccess: false,
    plainHttpEndpoint: null,
    discoveryStatus: null,
    refreshStatus: null,
    takesAnyCode: false,
    codeGate: null,
    nextClaims: null,
    signIn: (authorizationUrl, subject) => {
      const url = new URL(authorizationUrl);
      const returnUrl = url.searchParams.get("redirect_uri") ?? "";
      if (url.searchParams.get("client_id") !== CLIENT_ID || !fake.returnUrls.has(returnUrl)) {
        throw new Error("the fake J5 Connect would not send the browser back there");
      }
      const code = random();
      codes.set(code, {
        subject,
        nonce: url.searchParams.get("nonce") ?? "",
        returnUrl,
        challenge: url.searchParams.get("code_challenge") ?? "",
      });
      return code;
    },
  };

  const idToken = async (subject: string, nonce: string | undefined) => {
    const user = fake.users.get(subject)!;
    const claims = {
      iss: ISSUER,
      sub: subject,
      aud: CLIENT_ID,
      exp: 9_999_999_999,
      iat: 0,
      email: user.email,
      email_verified: user.emailVerified ?? true,
      name: user.name,
      ...(nonce === undefined ? {} : { nonce }),
      ...fake.nextClaims,
    };
    fake.nextClaims = null;
    const signed = `${encode({ alg: "RS256", kid: "fake-key" })}.${encode(claims)}`;
    const signature = await NodeCrypto.webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(signed),
    );
    return `${signed}.${Buffer.from(signature).toString("base64url")}`;
  };

  const tokens = async (
    subject: string,
    nonce: string | undefined,
    withIdToken = true,
    withRefreshToken = true,
  ) => {
    const refreshToken = random();
    refreshTokens.set(refreshToken, subject);
    return json({
      access_token: random(),
      token_type: "bearer",
      ...(withIdToken ? { id_token: await idToken(subject, nonce) } : {}),
      ...(withRefreshToken ? { refresh_token: refreshToken } : {}),
    });
  };

  /** What the token endpoint answers; `"stall"` for a refresh that never answers. */
  const token = async (
    headers: Record<string, string>,
    body: URLSearchParams,
  ): Promise<Response | "stall"> => {
    const basic = Buffer.from((headers.authorization ?? "").replace(/^Basic /, ""), "base64")
      .toString("utf8")
      .split(":")
      .map(decodeURIComponent);
    if (!CLIENT_IDS.has(basic[0] ?? "") || basic[1] !== CLIENT_SECRET) {
      return json({ error: "invalid_client" }, 401);
    }
    if (fake.outage) return json({ error: "invalid_request" }, 500);
    if (body.get("grant_type") === "authorization_code") {
      const code = codes.get(body.get("code") ?? "");
      if (code === undefined && fake.takesAnyCode) return json({ access_token: random() });
      if (code === undefined) return json({ error: "invalid_grant" }, 400);
      // A disabled account cannot sign in at all, as at a real identity provider.
      if (fake.users.get(code.subject)?.active !== true) {
        return json({ error: "access_denied" }, 403);
      }
      codes.delete(body.get("code") ?? "");
      const verifier = body.get("code_verifier") ?? "";
      const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
      if (code.returnUrl !== body.get("redirect_uri") || challenge !== code.challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      return tokens(code.subject, code.nonce, true, !fake.withoutOfflineAccess);
    }
    if (body.get("grant_type") === "refresh_token") {
      const presented = body.get("refresh_token") ?? "";
      const subject = refreshTokens.get(presented);
      if (subject !== undefined && fake.stall.has(subject)) return "stall";
      if (fake.refreshStatus !== null) {
        return new Response(null, {
          status: fake.refreshStatus,
          headers: { location: `${ISSUER}/elsewhere` },
        });
      }
      refreshTokens.delete(presented);
      // Dex refuses a disabled account's refresh with the same answer as an outage.
      if (subject === undefined || fake.users.get(subject)?.active !== true) {
        return json({ error: "invalid_request" }, 500);
      }
      return tokens(subject, undefined, !fake.refreshWithoutIdToken);
    }
    return json({ error: "unsupported_grant_type" }, 400);
  };

  const route = async (
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: string,
  ): Promise<Response | "stall"> => {
    if (url.origin !== ISSUER) return new Response("not found", { status: 404 });
    if (method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      if (fake.discoveryStatus !== null) {
        return new Response("unavailable", { status: fake.discoveryStatus });
      }
      const base =
        fake.plainHttpEndpoint === "outside"
          ? ISSUER.replace("https:", "http:")
          : fake.plainHttpEndpoint === "loopback"
            ? "http://127.0.0.1:5556"
            : ISSUER;
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${ISSUER}/keys`,
      });
    }
    if (method === "GET" && url.pathname === "/keys") {
      return json({ keys: [{ ...publicJwk, kid: "fake-key", alg: "RS256", use: "sig" }] });
    }
    if (method === "GET" && url.pathname === "/auth") {
      // Like Dex with one connector: on to it, where an unknown return address is refused.
      return new Response(null, {
        status: 302,
        headers: { location: `/auth/local${url.search}` },
      });
    }
    if (method === "GET" && url.pathname === "/auth/local") {
      const known =
        CLIENT_IDS.has(url.searchParams.get("client_id") ?? "") &&
        fake.returnUrls.has(url.searchParams.get("redirect_uri") ?? "");
      return known
        ? new Response("<form>sign in</form>", { status: 200 })
        : new Response("Unregistered redirect_uri.", { status: 400 });
    }
    if (method === "POST" && url.pathname === "/token") {
      return token(headers, new URLSearchParams(body));
    }
    return new Response("not found", { status: 404 });
  };

  const respond = Effect.fn("test.fakeConnect.respond")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    if (fake.down) {
      return yield* new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "connect refused" }),
      });
    }
    const body =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
    const params = new URLSearchParams(body);
    const gate = fake.codeGate;
    if (gate !== null && params.get("grant_type") === "authorization_code") {
      fake.codeGate = null;
      yield* Deferred.succeed(gate.entered, undefined);
      yield* Deferred.await(gate.release);
    }
    const response = yield* Effect.promise(() =>
      route(request.method, new URL(request.url), request.headers, body),
    );
    if (response === "stall") {
      if (fake.stalled !== null) yield* Deferred.succeed(fake.stalled, undefined);
      return yield* Effect.never;
    }
    return HttpClientResponse.fromWeb(request, response);
  });

  return Object.assign(fake, { client: HttpClient.make((request) => respond(request)) });
});

/** The fake J5 Connect, and the `HttpClient` that reaches it. */
export const layer = Layer.effectContext(
  Effect.map(make, (fake) =>
    Context.make(FakeConnect, fake).pipe(Context.add(HttpClient.HttpClient, fake.client)),
  ),
);

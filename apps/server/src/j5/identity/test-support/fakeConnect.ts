// @effect-diagnostics nodeBuiltinImport:off - the fake signs ID tokens and checks PKCE with Node's crypto.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * A J5 Connect in-process, behind an `HttpClient`: discovery, keys, an authorization endpoint that
 * knows its client's return addresses, and a token endpoint for codes and refreshes. Its refusal
 * of a disabled account and its outage answer alike, HTTP 500 `invalid_request`, as Dex's do.
 * Everything in it is invented.
 */

export const ISSUER = "https://connect.example.test";
export const CLIENT_ID = "j5-test-server";
export const CLIENT_SECRET = "invented-client-secret";

interface User {
  readonly email: string;
  readonly name: string;
  active: boolean;
}

interface Code {
  readonly subject: string;
  readonly nonce: string;
  readonly returnUrl: string;
  readonly challenge: string;
}

export interface FakeConnectShape {
  readonly client: HttpClient.HttpClient;
  readonly returnUrls: Set<string>;
  readonly users: Map<string, User>;
  /** While set, every token request answers as Dex does when its identity provider is down. */
  outage: boolean;
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
    outage: false,
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
      email: user.email,
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

  const tokens = async (subject: string, nonce: string | undefined) => {
    const refreshToken = random();
    refreshTokens.set(refreshToken, subject);
    return json({
      access_token: random(),
      token_type: "bearer",
      id_token: await idToken(subject, nonce),
      refresh_token: refreshToken,
    });
  };

  const token = async (headers: Record<string, string>, body: URLSearchParams) => {
    const basic = Buffer.from((headers.authorization ?? "").replace(/^Basic /, ""), "base64")
      .toString("utf8")
      .split(":")
      .map(decodeURIComponent);
    if (basic[0] !== CLIENT_ID || basic[1] !== CLIENT_SECRET) {
      return json({ error: "invalid_client" }, 401);
    }
    if (fake.outage) return json({ error: "invalid_request" }, 500);
    if (body.get("grant_type") === "authorization_code") {
      const code = codes.get(body.get("code") ?? "");
      if (code === undefined) return json({ error: "invalid_grant" }, 400);
      codes.delete(body.get("code") ?? "");
      const verifier = body.get("code_verifier") ?? "";
      const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
      if (code.returnUrl !== body.get("redirect_uri") || challenge !== code.challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      return tokens(code.subject, code.nonce);
    }
    if (body.get("grant_type") === "refresh_token") {
      const presented = body.get("refresh_token") ?? "";
      const subject = refreshTokens.get(presented);
      refreshTokens.delete(presented);
      // Dex refuses a disabled account's refresh with the same answer as an outage.
      if (subject === undefined || fake.users.get(subject)?.active !== true) {
        return json({ error: "invalid_request" }, 500);
      }
      return tokens(subject, undefined);
    }
    return json({ error: "unsupported_grant_type" }, 400);
  };

  const route = async (method: string, url: URL, headers: Record<string, string>, body: string) => {
    if (url.origin !== ISSUER) return new Response("not found", { status: 404 });
    if (method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
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
        url.searchParams.get("client_id") === CLIENT_ID &&
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

  return Object.assign(fake, {
    client: HttpClient.make((request) =>
      Effect.promise(async () => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const response = await route(request.method, new URL(request.url), request.headers, body);
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  });
});

/** The fake J5 Connect, and the `HttpClient` that reaches it. */
export const layer = Layer.effectContext(
  Effect.map(make, (fake) =>
    Context.make(FakeConnect, fake).pipe(Context.add(HttpClient.HttpClient, fake.client)),
  ),
);

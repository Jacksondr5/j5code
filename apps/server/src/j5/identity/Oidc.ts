// @effect-diagnostics nodeBuiltinImport:off - random state, nonce and PKCE verifier, its hash, and WebCrypto for ID tokens.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/**
 * The small OIDC client a J5 server is of its J5 Connect: the code flow with PKCE, state and
 * nonce, refresh, and the checks joining makes. No OIDC or JOSE library is a dependency, so this
 * is written on Effect's HTTP client, with ID tokens verified by WebCrypto. The issuer, audience
 * and return address are compared exactly.
 */

export class OidcError extends Schema.TaggedError<OidcError>()("OidcError", {
  stage: Schema.Literals(["discovery", "token", "refresh", "id_token", "probe"]),
  /**
   * The OAuth error code or HTTP status the J5 Connect answered with. Absent when it gave no
   * answer at all: unreachable, or too slow.
   */
  status: Schema.optional(Schema.String),
  /**
   * The HTTP status of the response the failure was read from. Absent when no readable response
   * decided it: unreachable, too slow, or an answer that could not be read.
   */
  httpStatus: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const said = this.status === undefined ? "" : ` (${this.status})`;
    switch (this.stage) {
      case "discovery":
        return `J5 Connect's configuration could not be read${said}.`;
      case "token":
        return `J5 Connect did not complete the sign-in${said}.`;
      case "refresh":
        return `J5 Connect did not confirm the account${said}.`;
      case "id_token":
        return "J5 Connect's answer did not check out, so it was not trusted.";
      case "probe":
        return `J5 Connect could not be asked about this server's client${said}.`;
    }
  }
}

/**
 * Whether a refresh's failure is J5 Connect's own answer about the account: a 2xx or a 4xx. A
 * redirect, a server error, a timeout or an unreadable answer says nothing about it.
 */
export const answered = (error: OidcError) =>
  error.httpStatus !== undefined &&
  ((error.httpStatus >= 200 && error.httpStatus < 300) ||
    (error.httpStatus >= 400 && error.httpStatus < 500));

/** Each request, its body included, ends by this, so a stalled J5 Connect holds nothing up. */
const REQUEST_TIMEOUT = "15 seconds";
const SCOPES = "openid email profile offline_access";
/** How far apart this server's clock and J5 Connect's may be. */
const CLOCK_SKEW_SECONDS = 120;

const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  jwks_uri: Schema.String,
});
export type Discovery = typeof Discovery.Type;

const TokenResponse = Schema.Struct({
  id_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
});

const OAuthErrorBody = Schema.Struct({ error: Schema.String });
/** The token endpoint's error codes (RFC 6749 §5.2, plus the two server-side ones). */
const OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

const Jwk = Schema.Struct({
  kty: Schema.String,
  kid: Schema.optional(Schema.String),
  alg: Schema.optional(Schema.String),
  use: Schema.optional(Schema.String),
  n: Schema.optional(Schema.String),
  e: Schema.optional(Schema.String),
  crv: Schema.optional(Schema.String),
  x: Schema.optional(Schema.String),
  y: Schema.optional(Schema.String),
});
const Jwks = Schema.Struct({ keys: Schema.Array(Jwk) });

const JwsHeader = Schema.Struct({ alg: Schema.String, kid: Schema.optional(Schema.String) });

const IdTokenClaims = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Number,
  iat: Schema.Number,
  nbf: Schema.optional(Schema.Number),
  azp: Schema.optional(Schema.String),
  nonce: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  email_verified: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
});

/** Who the J5 Connect said signed in. */
export interface Identity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly name: string | null;
}

const decodeDiscovery = Schema.decodeUnknownEffect(Discovery);
const decodeToken = Schema.decodeUnknownEffect(TokenResponse);
const decodeOAuthError = Schema.decodeUnknownOption(OAuthErrorBody);
const decodeJwks = Schema.decodeUnknownEffect(Jwks);
const decodeHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(JwsHeader));
const decodeClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(IdTokenClaims));

const randomToken = () => NodeCrypto.randomBytes(32).toString("base64url");

/** A fresh state, nonce and PKCE verifier for one sign-in, with the verifier's S256 challenge. */
export const newSignIn = () => {
  const codeVerifier = randomToken();
  return {
    state: randomToken(),
    nonce: randomToken(),
    codeVerifier,
    codeChallenge: NodeCrypto.createHash("sha256").update(codeVerifier).digest("base64url"),
  };
};

const LOOPBACK_HOSTS = new Set(["localhost", "[::1]"]);

/** HTTPS, or plain HTTP to this machine only: tokens and codes travel on these addresses. */
const isSafeOidcUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (LOOPBACK_HOSTS.has(url.hostname) || /^127(\.\d{1,3}){3}$/.test(url.hostname))
    );
  } catch {
    return false;
  }
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/**
 * One request to the J5 Connect and its whole body, bounded together. Redirects are not followed:
 * an OIDC endpoint that redirects answers with its redirect, which nothing here accepts.
 */
const exchange = Effect.fn("j5.identity.oidc.exchange")(function* (
  stage: OidcError["stage"],
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(request).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((text) => ({
          status: response.status,
          text,
          body: parseJson(text),
          response,
        })),
      ),
    ),
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.mapError((cause) => new OidcError({ stage, cause })),
  );
});

/** The discovery document at the issuer, refused unless it names exactly that issuer. */
export const discover = Effect.fn("j5.identity.oidc.discover")(function* (issuer: string) {
  if (!isSafeOidcUrl(issuer)) {
    return yield* new OidcError({ stage: "discovery", status: "issuer is not https" });
  }
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const { status, body } = yield* exchange(
    "discovery",
    HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson),
  );
  if (status !== 200) return yield* new OidcError({ stage: "discovery", status: String(status) });
  const document = yield* decodeDiscovery(body).pipe(
    Effect.mapError((cause) => new OidcError({ stage: "discovery", status: "unreadable", cause })),
  );
  if (document.issuer !== issuer) {
    return yield* new OidcError({ stage: "discovery", status: "issuer mismatch" });
  }
  // A J5 Connect served over HTTPS names only HTTPS endpoints; plain HTTP to this machine is for a
  // J5 Connect that is itself on this machine.
  const issuerIsHttps = new URL(issuer).protocol === "https:";
  for (const endpoint of [
    document.authorization_endpoint,
    document.token_endpoint,
    document.jwks_uri,
  ]) {
    if (!isSafeOidcUrl(endpoint) || (issuerIsHttps && new URL(endpoint).protocol !== "https:")) {
      return yield* new OidcError({ stage: "discovery", status: "endpoint is not https" });
    }
  }
  return document;
});

/** Where the browser goes to sign in. */
export const authorizationUrl = (input: {
  readonly discovery: Discovery;
  readonly clientId: string;
  readonly returnUrl: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}) => {
  const url = new URL(input.discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.returnUrl);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
};

/** Posts to the token endpoint with the client's secret, as HTTP Basic. */
const postToken = Effect.fn("j5.identity.oidc.postToken")(function* (
  stage: "token" | "refresh",
  input: {
    readonly discovery: Discovery;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly params: Record<string, string>;
  },
) {
  const { status, text, body } = yield* exchange(
    stage,
    HttpClientRequest.post(input.discovery.token_endpoint).pipe(
      HttpClientRequest.basicAuth(
        encodeURIComponent(input.clientId),
        encodeURIComponent(input.clientSecret),
      ),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyUrlParams(input.params),
    ),
  );
  if (status !== 200) {
    // Only the HTTP status and an OAuth error code it recognizes; the raw answer stays in `cause`.
    const said = Option.match(decodeOAuthError(body), {
      onNone: () => String(status),
      onSome: (error) =>
        OAUTH_ERROR_CODES.has(error.error) ? `${String(status)} ${error.error}` : String(status),
    });
    return yield* new OidcError({ stage, status: said, httpStatus: status, cause: text });
  }
  return yield* decodeToken(body).pipe(
    Effect.mapError((cause) => new OidcError({ stage, status: "unreadable", cause })),
  );
});

const base64UrlBytes = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

const ALGORITHMS: Record<
  string,
  {
    readonly kty: string;
    readonly import:
      | NodeCrypto.webcrypto.RsaHashedImportParams
      | NodeCrypto.webcrypto.EcKeyImportParams;
  }
> = {
  RS256: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } },
  ES256: { kty: "EC", import: { name: "ECDSA", namedCurve: "P-256" } },
};

/**
 * Verifies an ID token's signature against the J5 Connect's keys, then its issuer, audience,
 * times and, at sign-in, nonce. Anything that does not check out is refused alike.
 */
const verifyIdToken = Effect.fn("j5.identity.oidc.verifyIdToken")(function* (input: {
  readonly discovery: Discovery;
  readonly clientId: string;
  readonly idToken: string;
  readonly nonce: string | null;
  readonly nowMillis: number;
}) {
  // The ID token came in a 2xx, so a token that does not check out is J5 Connect's answer.
  const refused = (status: string) => new OidcError({ stage: "id_token", status, httpStatus: 200 });
  const parts = input.idToken.split(".");
  if (parts.length !== 3) return yield* refused("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = yield* decodeHeader(Buffer.from(headerPart, "base64url").toString("utf8")).pipe(
    Effect.mapError(() => refused("header")),
  );
  if (!Object.hasOwn(ALGORITHMS, header.alg)) return yield* refused("algorithm");
  const algorithm = ALGORITHMS[header.alg]!;

  const fetched = yield* exchange(
    "id_token",
    HttpClientRequest.get(input.discovery.jwks_uri).pipe(HttpClientRequest.acceptJson),
  );
  // Keys it could not serve, or served unreadable, say nothing about the account (`answered`).
  if (fetched.status !== 200) {
    return yield* new OidcError({
      stage: "id_token",
      status: `${String(fetched.status)} keys`,
      httpStatus: fetched.status,
    });
  }
  const keys = yield* decodeJwks(fetched.body).pipe(
    Effect.mapError(() => new OidcError({ stage: "id_token", status: "keys" })),
  );
  const key = keys.keys.find(
    (candidate) =>
      candidate.kty === algorithm.kty &&
      (header.kid === undefined || candidate.kid === header.kid) &&
      (candidate.alg === undefined || candidate.alg === header.alg) &&
      (candidate.use === undefined || candidate.use === "sig"),
  );
  if (key === undefined) return yield* refused("key");
  const verified = yield* Effect.tryPromise({
    try: async () => {
      const subtle = NodeCrypto.webcrypto.subtle;
      const cryptoKey = await subtle.importKey(
        "jwk",
        key as NodeCrypto.webcrypto.JsonWebKey,
        algorithm.import,
        false,
        ["verify"],
      );
      return subtle.verify(
        algorithm.kty === "EC" ? { name: "ECDSA", hash: "SHA-256" } : algorithm.import.name,
        cryptoKey,
        base64UrlBytes(signaturePart),
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      );
    },
    catch: (cause) =>
      new OidcError({ stage: "id_token", status: "signature", httpStatus: 200, cause }),
  });
  if (!verified) return yield* refused("signature");

  const claims = yield* decodeClaims(Buffer.from(payloadPart, "base64url").toString("utf8")).pipe(
    Effect.mapError(() => refused("claims")),
  );
  const nowSeconds = input.nowMillis / 1000;
  if (claims.iss !== input.discovery.issuer) return yield* refused("issuer");
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!audiences.includes(input.clientId)) return yield* refused("audience");
  if (claims.azp !== undefined && claims.azp !== input.clientId) return yield* refused("azp");
  if (audiences.length > 1 && claims.azp === undefined) return yield* refused("azp");
  if (claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) return yield* refused("expired");
  if (claims.nbf !== undefined && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    return yield* refused("not yet valid");
  }
  if (claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    return yield* refused("issued in the future");
  }
  if (input.nonce !== null && claims.nonce !== input.nonce) return yield* refused("nonce");
  return {
    issuer: claims.iss,
    subject: claims.sub,
    // An email J5 Connect has not verified is never shown as who someone is.
    email: claims.email_verified === true ? (claims.email ?? null) : null,
    name: claims.name ?? null,
  } satisfies Identity;
});

/** Trades a sign-in's code for its verified identity and refresh token. */
export const exchangeCode = Effect.fn("j5.identity.oidc.exchangeCode")(function* (input: {
  readonly discovery: Discovery;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly returnUrl: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly nowMillis: number;
}) {
  const tokens = yield* postToken("token", {
    discovery: input.discovery,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    params: {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.returnUrl,
      code_verifier: input.codeVerifier,
    },
  });
  if (tokens.id_token === undefined) {
    return yield* new OidcError({ stage: "token", status: "no id_token" });
  }
  const identity = yield* verifyIdToken({
    discovery: input.discovery,
    clientId: input.clientId,
    idToken: tokens.id_token,
    nonce: input.nonce,
    nowMillis: input.nowMillis,
  });
  // Every bound account is confirmed by refresh, so a sign-in without one is refused.
  if (tokens.refresh_token === undefined || tokens.refresh_token === "") {
    return yield* new OidcError({
      stage: "token",
      status:
        "no refresh token: J5 Connect didn't grant offline access; check its connector config",
    });
  }
  return { identity, refreshToken: tokens.refresh_token };
});

/**
 * Refreshes an account's sign-in, which only succeeds while its upstream account is active. The
 * answer must carry an ID token for the same account, as Dex's does for an `openid` client; one
 * without confirms nothing. Returns the refresh token to keep.
 */
export const refresh = Effect.fn("j5.identity.oidc.refresh")(function* (input: {
  readonly discovery: Discovery;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly subject: string;
  readonly nowMillis: number;
}) {
  const tokens = yield* postToken("refresh", {
    discovery: input.discovery,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    params: { grant_type: "refresh_token", refresh_token: input.refreshToken },
  });
  if (tokens.id_token === undefined) {
    return yield* new OidcError({ stage: "refresh", status: "no id_token", httpStatus: 200 });
  }
  const identity = yield* verifyIdToken({
    discovery: input.discovery,
    clientId: input.clientId,
    idToken: tokens.id_token,
    nonce: null,
    nowMillis: input.nowMillis,
  });
  if (identity.subject !== input.subject) {
    return yield* new OidcError({ stage: "id_token", status: "subject", httpStatus: 200 });
  }
  // An empty token is none: the one kept stays.
  return tokens.refresh_token || input.refreshToken;
});

/**
 * Whether the J5 Connect takes this client's secret: a made-up code is refused as an invalid
 * grant when the secret is right, and as an invalid client when it is not.
 */
export const secretAccepted = Effect.fn("j5.identity.oidc.secretAccepted")(function* (input: {
  readonly discovery: Discovery;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly returnUrl: string;
}) {
  return yield* postToken("token", {
    discovery: input.discovery,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    params: {
      grant_type: "authorization_code",
      code: "j5-join-check",
      redirect_uri: input.returnUrl,
    },
  }).pipe(
    Effect.matchEffect({
      // A J5 Connect that takes a made-up code can't be judged by it.
      onSuccess: () =>
        Effect.fail(new OidcError({ stage: "probe", status: "took a made-up code" })),
      // Only a client error about the made-up code says the secret was taken: Dex answers an
      // outage with a 500 `invalid_request` too.
      onFailure: (error) =>
        error.status !== undefined && /\binvalid_client\b|^401\b/.test(error.status)
          ? Effect.succeed(false)
          : error.status !== undefined &&
              /^4\d\d (invalid_grant|invalid_request)$/.test(error.status)
            ? Effect.succeed(true)
            : Effect.fail(new OidcError({ stage: "probe", status: error.status, cause: error })),
    }),
  );
});

const MAX_PROBE_HOPS = 5;

/**
 * Whether the J5 Connect would send a browser back to `returnUrl` for this client. It is asked to
 * start a sign-in there, following its own redirects only: an unknown client or return address
 * ends on its error page, and a known one reaches a sign-in page or leaves for the identity
 * provider behind it. Nothing is signed in.
 */
export const returnUrlRegistered = Effect.fn("j5.identity.oidc.returnUrlRegistered")(
  function* (input: {
    readonly discovery: Discovery;
    readonly clientId: string;
    readonly returnUrl: string;
  }) {
    const probe = newSignIn();
    const issuerOrigin = new URL(input.discovery.authorization_endpoint).origin;
    let url = authorizationUrl({ ...input, ...probe });
    for (let hop = 0; hop < MAX_PROBE_HOPS; hop += 1) {
      const { status, response } = yield* exchange("probe", HttpClientRequest.get(url));
      if (status >= 300 && status < 400) {
        const location = response.headers.location;
        if (location === undefined) return false;
        const next = new URL(location, url);
        if (next.origin !== issuerOrigin) return true;
        url = next.toString();
        continue;
      }
      return status >= 200 && status < 300;
    }
    return false;
  },
);

import { AuthAccessWriteScope } from "@t3tools/contracts";
import {
  J5_IDENTITY_CALLBACK_PATH,
  J5_IDENTITY_CLI_JOIN_PATH,
  J5_IDENTITY_CLI_LEAVE_PATH,
  J5_IDENTITY_CLI_RETURN_URLS_PATH,
  J5_IDENTITY_DESCRIBE_PATH,
  J5_IDENTITY_SIGN_IN_PATH,
  J5_SIGN_IN_APP_PARAM,
  J5_SIGN_IN_OUTCOME_PARAM,
  JoinConnectRequest,
  JoinedConnectJson,
  ReturnUrlsRequest,
  type SignInOutcome,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { requestUrl } from "../../requestUrl.ts";
import {
  authenticate,
  jsonError,
  readJsonBody,
  requestFailure,
  requireScope,
  respondableTags,
} from "../a2a/httpSupport.ts";
import { CLI_SESSION_SUBJECT } from "../sharing/cliPairing.ts";
import { Identity } from "./Identity.ts";

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;
const decodeJoin = Schema.decodeUnknownEffect(JoinConnectRequest);
const decodeReturnUrls = Schema.decodeUnknownEffect(ReturnUrlsRequest);
const encodeJoined = Schema.encodeSync(JoinedConnectJson);

/** Back to the pairing page, which exchanges a credential as it does a link's. */
const toPairing = (outcome: SignInOutcome | { readonly credential: string }) =>
  HttpServerResponse.redirect(
    typeof outcome === "string"
      ? `/pair?${J5_SIGN_IN_OUTCOME_PARAM}=${outcome}`
      : `/pair#token=${encodeURIComponent(outcome.credential)}`,
    { headers: NO_STORE },
  );

/**
 * Where a device signs in through J5 Connect, and where J5 Connect sends it back. Neither takes a
 * sign-in to J5: the state, nonce and PKCE verifier tie the two ends together, and the account J5
 * Connect vouches for decides the rest. The `j5 auth connect` commands join and leave through the
 * CLI's own short session, as `j5 pair` does.
 */
export const identityHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const wired = yield* Effect.serviceOption(Identity);
    if (Option.isNone(wired)) return Layer.empty;
    const identity = wired.value;

    const describeRoute = HttpRouter.add(
      "GET",
      J5_IDENTITY_DESCRIBE_PATH,
      identity.describe.pipe(
        Effect.map((description) => HttpServerResponse.jsonUnsafe(description)),
        Effect.catch((cause) =>
          Effect.logError("J5 identity describe failed", { cause }).pipe(
            Effect.as(HttpServerResponse.jsonUnsafe({ signIn: null })),
          ),
        ),
      ),
    );

    const signInRoute = HttpRouter.add(
      "GET",
      J5_IDENTITY_SIGN_IN_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        if (Option.isNone(url)) return toPairing("failed");
        // `app` is the desktop or mobile app's link scheme, when it opened this in a browser.
        const appScheme = url.value.searchParams.get(J5_SIGN_IN_APP_PARAM);
        return yield* identity.startSignIn({ origin: url.value.origin, appScheme }).pipe(
          Effect.map((location) => HttpServerResponse.redirect(location, { headers: NO_STORE })),
          Effect.catch((cause) =>
            Effect.logWarning("J5 sign-in could not start", { cause }).pipe(
              Effect.as(toPairing("failed")),
            ),
          ),
        );
      }),
    );

    const callbackRoute = HttpRouter.add(
      "GET",
      J5_IDENTITY_CALLBACK_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        const state = Option.isSome(url) ? url.value.searchParams.get("state") : null;
        const code = Option.isSome(url) ? url.value.searchParams.get("code") : null;
        if (Option.isNone(url) || state === null || code === null) {
          // J5 Connect sends `error` back when the person cancelled or was refused there.
          return toPairing("failed");
        }
        return yield* identity.completeSignIn({ state, code, origin: url.value.origin }).pipe(
          Effect.map((outcome) =>
            outcome.kind !== "pair"
              ? toPairing(outcome.kind)
              : outcome.appLink !== null
                ? HttpServerResponse.redirect(outcome.appLink, { headers: NO_STORE })
                : toPairing(outcome),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("J5 sign-in could not finish", { cause }).pipe(
              Effect.as(toPairing("failed")),
            ),
          ),
        );
      }),
    );

    /** Only the `j5` CLI's own session, which holds Manage access, joins or leaves here. */
    const cliSession = Effect.gen(function* () {
      const session = yield* authenticate;
      yield* requireScope(session, AuthAccessWriteScope);
      return session.subject === CLI_SESSION_SUBJECT;
    });

    const cliRefusal = (error: { readonly _tag: string; readonly message: string }) =>
      Effect.succeed(jsonError(400, error._tag, error.message));

    const cliJoinRoute = HttpRouter.add(
      "POST",
      J5_IDENTITY_CLI_JOIN_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.identity.cliJoin");
        if (!(yield* cliSession)) {
          return jsonError(403, "cli_session_required", "Only the j5 CLI joins here.");
        }
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeJoin(body.success));
        if (Result.isFailure(decoded)) return requestFailure("The join flags are malformed.");
        return yield* identity
          .join({
            issuer: decoded.success.issuer,
            clientId: decoded.success.clientId,
            clientSecret: decoded.success.clientSecret,
            addresses: decoded.success.addresses ?? [],
          })
          .pipe(
            Effect.map((joined) => HttpServerResponse.jsonUnsafe(encodeJoined(joined))),
            Effect.catchTags({
              OidcError: cliRefusal,
              ClientSecretRefusedError: cliRefusal,
              ReturnUrlsNotRegisteredError: cliRefusal,
              SignInSessionsLiveError: cliRefusal,
            }),
          );
      }).pipe(
        Effect.catchTags(respondableTags),
        Effect.catch((cause) =>
          Effect.logError("J5 Connect join failed", { cause }).pipe(
            Effect.as(jsonError(500, "join_failed", "Joining J5 Connect failed.")),
          ),
        ),
      ),
    );

    const cliLeaveRoute = HttpRouter.add(
      "POST",
      J5_IDENTITY_CLI_LEAVE_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.identity.cliLeave");
        if (!(yield* cliSession)) {
          return jsonError(403, "cli_session_required", "Only the j5 CLI leaves here.");
        }
        return yield* identity.leave.pipe(
          Effect.as(HttpServerResponse.jsonUnsafe({})),
          Effect.catchTags({ SignInSessionsLiveError: cliRefusal }),
        );
      }).pipe(
        Effect.catchTags(respondableTags),
        Effect.catch((cause) =>
          Effect.logError("J5 Connect leave failed", { cause }).pipe(
            Effect.as(jsonError(500, "leave_failed", "Leaving J5 Connect failed.")),
          ),
        ),
      ),
    );

    const cliReturnUrlsRoute = HttpRouter.add(
      "POST",
      J5_IDENTITY_CLI_RETURN_URLS_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.identity.cliReturnUrls");
        if (!(yield* cliSession)) {
          return jsonError(403, "cli_session_required", "Only the j5 CLI asks here.");
        }
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeReturnUrls(body.success));
        if (Result.isFailure(decoded)) return requestFailure("The addresses are malformed.");
        const returnUrls = yield* identity.returnUrls(decoded.success.addresses ?? []);
        return HttpServerResponse.jsonUnsafe({ returnUrls });
      }).pipe(Effect.catchTags(respondableTags)),
    );

    return Layer.mergeAll(
      describeRoute,
      signInRoute,
      callbackRoute,
      cliJoinRoute,
      cliLeaveRoute,
      cliReturnUrlsRoute,
    );
  }),
);

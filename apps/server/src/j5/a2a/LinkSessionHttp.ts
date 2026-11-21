import { ClaimLinkSessionRequest, J5_LINK_SESSION_API_PATH } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { jsonError, readJsonBody, requestFailure } from "./httpSupport.ts";
import { LinkSessionService } from "./LinkSessionService.ts";

const decodeClaim = Schema.decodeUnknownEffect(ClaimLinkSessionRequest);

/**
 * A server that linked to this one speaks for that link's session, presenting the link's own
 * token: nothing else can name the session, and a token can only claim or revoke itself.
 */
export const linkSessionHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const linkSessions = yield* LinkSessionService;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

    const linkSession = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const client = yield* Effect.result(serverAuth.authenticateMcpClient(request));
      if (Result.isFailure(client)) {
        return Result.fail(
          EnvironmentAuth.isServerAuthCredentialError(client.failure)
            ? jsonError(401, "invalid_credential", "This token is not a live link session.")
            : jsonError(500, "internal_error", "The link session could not be read."),
        );
      }
      return client.success.peerLink
        ? Result.succeed(client.success.sessionId)
        : Result.fail(
            jsonError(403, "not_a_link_session", "Only a linked environment's token is accepted."),
          );
    });

    const failed = (operation: string) => (cause: unknown) =>
      Effect.logError(`J5 link session ${operation} failed`, { cause }).pipe(
        Effect.as(jsonError(500, "internal_error", `The link session ${operation} failed.`)),
      );

    const claimRoute = HttpRouter.add(
      "PUT",
      J5_LINK_SESSION_API_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.links.session.claim");
        const session = yield* linkSession;
        if (Result.isFailure(session)) return session.failure;
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeClaim(body.success));
        if (Result.isFailure(decoded)) return requestFailure("environmentId is required.");
        return yield* linkSessions
          .claim({ sessionId: session.success, environmentId: decoded.success.environmentId })
          .pipe(
            Effect.as(HttpServerResponse.empty({ status: 204 })),
            Effect.catch(failed("claim")),
          );
      }),
    );

    const releaseRoute = HttpRouter.add(
      "DELETE",
      J5_LINK_SESSION_API_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.links.session.release");
        const session = yield* linkSession;
        if (Result.isFailure(session)) return session.failure;
        return yield* linkSessions
          .release(session.success)
          .pipe(
            Effect.as(HttpServerResponse.empty({ status: 204 })),
            Effect.catch(failed("release")),
          );
      }),
    );

    return Layer.mergeAll(claimRoute, releaseRoute);
  }),
);

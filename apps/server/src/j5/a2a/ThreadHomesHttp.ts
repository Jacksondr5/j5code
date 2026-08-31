import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import {
  ThreadHomesRequest,
  ThreadHomesResponse,
  ThreadHomesService,
} from "./ThreadHomesService.ts";

export const THREAD_HOMES_PATH = "/api/j5/a2a/thread-homes";

const decodeThreadHomesRequest = Schema.decodeUnknownEffect(ThreadHomesRequest);
const encodeThreadHomesResponse = Schema.encodeEffect(ThreadHomesResponse);

const authenticateRead = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationReadScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  }
});

const requestFailure = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: "invalid_request", message }, { status: 400 });

const operationFailure = (cause: unknown) =>
  Effect.logError("J5 A2A thread-home read failed", { cause }).pipe(
    Effect.as(
      HttpServerResponse.jsonUnsafe(
        {
          error:
            typeof cause === "object" && cause !== null && "_tag" in cause
              ? String(cause._tag)
              : "ThreadHomeReadError",
          message: "Thread-home lookup failed.",
        },
        { status: 500 },
      ),
    ),
  );

/** Authenticated raw route; SQ1's aggregate owns its sole server composition seam. */
export const threadHomesHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const threadHomes = yield* ThreadHomesService;
    const route = HttpRouter.add(
      "POST",
      THREAD_HOMES_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.threadHomes.read");
        yield* authenticateRead;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeThreadHomesRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure("A threadIds array is required.");
        }
        const result = yield* Effect.result(
          threadHomes
            .threadHomes(decoded.success.threadIds)
            .pipe(Effect.flatMap(encodeThreadHomesResponse)),
        );
        if (Result.isSuccess(result)) return HttpServerResponse.jsonUnsafe(result.success);
        return yield* operationFailure(result.failure);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
    return route;
  }),
);

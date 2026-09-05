import { AuthOrchestrationReadScope, ThreadId } from "@t3tools/contracts";
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
import { A2AArchiveFacts } from "./ArchiveFactsService.ts";

export const PRE_ARCHIVE_FACTS_PATH = "/api/j5/a2a/pre-archive-facts";

const PreArchiveFactsRequest = Schema.Struct({ threadId: ThreadId });
const decodePreArchiveFactsRequest = Schema.decodeUnknownEffect(PreArchiveFactsRequest);

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
  Effect.logError("J5 A2A pre-archive fact read failed", { cause }).pipe(
    Effect.as(
      HttpServerResponse.jsonUnsafe(
        {
          error:
            typeof cause === "object" && cause !== null && "_tag" in cause
              ? String(cause._tag)
              : "PreArchiveFactsReadError",
          message: "Pre-archive fact lookup failed.",
        },
        { status: 500 },
      ),
    ),
  );

/** AR2's human-facing, authenticated read; it performs no archive mutation. */
export const preArchiveFactsHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const archiveFacts = yield* A2AArchiveFacts;
    const route = HttpRouter.add(
      "POST",
      PRE_ARCHIVE_FACTS_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.preArchiveFacts.read");
        yield* authenticateRead;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodePreArchiveFactsRequest(body.success));
        if (Result.isFailure(decoded)) return requestFailure("A valid threadId is required.");
        const result = yield* Effect.result(archiveFacts.readForThread(decoded.success.threadId));
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

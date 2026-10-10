import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import { A2AHumanInbox } from "./HumanInboxService.ts";
import { ParticipantId } from "./contracts.ts";
import { J5_API_PATHS, type HumanInboxResponse } from "@t3tools/contracts/j5";

const INBOX_PATH = J5_API_PATHS.inbox;

const authenticate = (scope: typeof AuthOrchestrationReadScope) =>
  Effect.gen(function* () {
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
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

const requestFailure = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: "invalid_request", message }, { status: 400 });

const operationFailure = (error: unknown) => {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "A2AHumanInboxError";
  const message = error instanceof Error ? error.message : "Human inbox operation failed.";
  const status =
    tag === "A2AExchangeNotOpenError" || tag === "A2AExchangeAlreadyAnsweredError"
      ? 409
      : tag === "A2AParticipantNotFoundError"
        ? 404
        : tag === "A2AHumanPersonIdError" || tag === "SchemaError"
          ? 400
          : 500;
  return HttpServerResponse.jsonUnsafe({ error: tag, message }, { status });
};

/** The human inbox's read. Answering an Exchange is an RPC (`clientActionRpc.ts`). */
export const humanInboxHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const inbox = yield* A2AHumanInbox;
    const listRoute = HttpRouter.add(
      "GET",
      INBOX_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.humanInbox.list");
        yield* authenticate(AuthOrchestrationReadScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) return requestFailure("The request URL is invalid.");
        const requestedPersonId = url.value.searchParams.get("personId");
        const requestedStatus = url.value.searchParams.get("status") ?? "open";
        if (requestedStatus !== "open" && requestedStatus !== "answered") {
          return requestFailure("status must be open or answered.");
        }
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const personId = yield* inbox.resolvePersonId(
              requestedPersonId === null || requestedPersonId.length === 0
                ? undefined
                : ParticipantId.make(requestedPersonId),
            );
            return { personId, items: yield* inbox.list(personId, requestedStatus) };
          }),
        );
        return Result.isSuccess(result)
          ? HttpServerResponse.jsonUnsafe(result.success satisfies HumanInboxResponse)
          : operationFailure(result.failure);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
    return listRoute;
  }),
);

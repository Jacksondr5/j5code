import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  CreateSquadronRequest,
  J5_API_PATHS,
  type SquadronListResponse,
  type CreateSquadronResponse,
} from "@t3tools/contracts/j5";
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

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { authenticate as sharedAuthenticate, requireScope } from "./httpSupport.ts";
import { SquadronManagementService } from "./SquadronManagementService.ts";

const SQUADRONS_PATH = J5_API_PATHS.squadrons;
const decodeCreateSquadronRequest = Schema.decodeUnknownEffect(CreateSquadronRequest);

export const authenticate = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const session = yield* sharedAuthenticate;
    yield* requireScope(session, scope);
  });

export const requestFailure = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: "invalid_request", message }, { status: 400 });

export const operationFailure = (error: unknown) => {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "SquadronOperationError";
  const message = error instanceof Error ? error.message : "Squadron operation failed.";
  const status =
    tag === "SquadronProjectNotFoundError" ||
    tag === "SquadronProjectReferenceSquadronNotFoundError"
      ? 404
      : tag === "A2AHomeConflictError" ||
          tag === "SquadronThreadCreationProjectReferenceError" ||
          tag === "SquadronJoinProjectReferenceError"
        ? 409
        : tag === "SquadronNameRequiredError" ||
            tag === "SquadronThreadCreationMissingSquadronError" ||
            tag === "SchemaError"
          ? 400
          : 500;
  if (status === 500) {
    return Effect.logError("J5 Squadron operation failed", { cause: error }).pipe(
      Effect.as(
        HttpServerResponse.jsonUnsafe(
          { error: "SquadronOperationError", message: "Squadron operation failed." },
          { status: 500 },
        ),
      ),
    );
  }
  return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: tag, message }, { status }));
};

/** Authenticated raw routes keep SQ1's creation choreography out of shared wire contracts. */
export const squadronHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const management = yield* SquadronManagementService;
    const listRoute = HttpRouter.add(
      "GET",
      SQUADRONS_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.squadron.list");
        yield* authenticate(AuthOrchestrationReadScope);
        const result = yield* Effect.result(management.list());
        if (Result.isSuccess(result)) {
          return HttpServerResponse.jsonUnsafe({
            squadrons: result.success,
          } satisfies typeof SquadronListResponse.Type);
        }
        return yield* operationFailure(result.failure);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
    const createRoute = HttpRouter.add(
      "POST",
      SQUADRONS_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.squadron.create");
        yield* authenticate(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeCreateSquadronRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure("A Squadron name and exactly one existing project are required.");
        }
        const result = yield* Effect.result(management.create(decoded.success));
        if (Result.isSuccess(result)) {
          return HttpServerResponse.jsonUnsafe(
            { squadron: result.success } satisfies typeof CreateSquadronResponse.Type,
            { status: 201 },
          );
        }
        return yield* operationFailure(result.failure);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
    return Layer.mergeAll(listRoute, createRoute);
  }),
);

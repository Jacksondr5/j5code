import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  CreateSquadronRequest,
  DeleteSquadronRequest,
  J5_API_PATHS,
  RenameSquadronRequest,
  type SquadronListResponse,
  type CreateSquadronResponse,
  type DeleteSquadronResponse,
  type RenameSquadronResponse,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { SquadronNotFoundError } from "./LedgerService.ts";
import { SquadronManagementService } from "./SquadronManagementService.ts";
import { SquadronId } from "./contracts.ts";

const SQUADRONS_PATH = J5_API_PATHS.squadrons;
// Rename and delete ride POST so browser clients on other origins pass the CORS method allowlist.
const SQUADRON_RENAME_PATH = `${SQUADRONS_PATH}/:id/rename` as const;
const SQUADRON_DELETE_PATH = `${SQUADRONS_PATH}/:id/delete` as const;
const decodeCreateSquadronRequest = Schema.decodeUnknownEffect(CreateSquadronRequest);
const decodeRenameSquadronRequest = Schema.decodeUnknownEffect(RenameSquadronRequest);
const decodeDeleteSquadronRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DeleteSquadronRequest),
);
const decodeSquadronId = Schema.decodeUnknownOption(SquadronId);

/** The router hands params back raw, so the client's encoded `squadron:<uuid>` is decoded here. */
const squadronIdParam = Effect.map(HttpRouter.params, (params) => {
  const segment = params.id ?? "";
  // A malformed escape falls through as the literal segment and fails the id decode below.
  const raw = Option.getOrElse(Option.liftThrowable(decodeURIComponent)(segment), () => segment);
  return { raw, id: decodeSquadronId(raw) };
});

export const authenticate = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
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
    tag === "SquadronProjectReferenceSquadronNotFoundError" ||
    tag === "SquadronNotFoundError"
      ? 404
      : tag === "A2AHomeConflictError" ||
          tag === "SquadronThreadCreationProjectReferenceError" ||
          tag === "SquadronDeleteBlockedError" ||
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
    const renameRoute = HttpRouter.add(
      "POST",
      SQUADRON_RENAME_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.squadron.rename");
        yield* authenticate(AuthOrchestrationOperateScope);
        const param = yield* squadronIdParam;
        if (Option.isNone(param.id)) {
          return yield* operationFailure(new SquadronNotFoundError({ squadronId: param.raw }));
        }
        const squadronId = param.id.value;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeRenameSquadronRequest(body.success));
        if (Result.isFailure(decoded)) return requestFailure("A Squadron name is required.");
        const result = yield* Effect.result(
          management.rename({ squadronId, name: decoded.success.name }),
        );
        if (Result.isSuccess(result)) {
          return HttpServerResponse.jsonUnsafe({
            squadron: result.success,
          } satisfies typeof RenameSquadronResponse.Type);
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
    const deleteRoute = HttpRouter.add(
      "POST",
      SQUADRON_DELETE_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.squadron.delete");
        yield* authenticate(AuthOrchestrationOperateScope);
        const param = yield* squadronIdParam;
        if (Option.isNone(param.id)) {
          return yield* operationFailure(new SquadronNotFoundError({ squadronId: param.raw }));
        }
        const squadronId = param.id.value;
        // An empty body is a plain delete, which refuses while live agents or Crews remain.
        const request = yield* HttpServerRequest.HttpServerRequest;
        const text = yield* Effect.result(request.text);
        if (Result.isFailure(text)) return requestFailure("The request body could not be read.");
        const decoded = yield* Effect.result(
          decodeDeleteSquadronRequest(text.success.trim() === "" ? "{}" : text.success),
        );
        if (Result.isFailure(decoded)) return requestFailure("force must be a boolean.");
        const result = yield* Effect.result(
          management.delete(squadronId, { force: decoded.success.force === true }),
        );
        if (Result.isSuccess(result)) {
          return HttpServerResponse.jsonUnsafe({
            deleted: true,
            squadronId,
          } satisfies typeof DeleteSquadronResponse.Type);
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
    return Layer.mergeAll(listRoute, createRoute, renameRoute, deleteRoute);
  }),
);

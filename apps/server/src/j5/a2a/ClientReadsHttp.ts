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
  ClientReadsService,
  type ClientReadsError,
  ParticipantIdentitiesRequest,
  ParticipantIdentitiesResponse,
  ParticipantHomesRequest,
  ParticipantHomesResponse,
  OpenInboxCount,
} from "./ClientReadsService.ts";
import { ParticipantId } from "./contracts.ts";

export const CLIENT_READS_PARTICIPANT_HOMES_PATH = "/api/j5/a2a/client-reads/participant-homes";
export const CLIENT_READS_PARTICIPANT_IDENTITIES_PATH =
  "/api/j5/a2a/client-reads/participant-identities";
export const CLIENT_READS_OPEN_COUNT_PATH = "/api/j5/a2a/client-reads/open-count";

const OpenInboxCountRequest = Schema.Struct({ personId: Schema.optionalKey(ParticipantId) });
const decodeParticipantHomesRequest = Schema.decodeUnknownEffect(ParticipantHomesRequest);
const decodeParticipantIdentitiesRequest = Schema.decodeUnknownEffect(ParticipantIdentitiesRequest);
const decodeOpenInboxCountRequest = Schema.decodeUnknownEffect(OpenInboxCountRequest);
const encodeParticipantHomesResponse = Schema.encodeEffect(ParticipantHomesResponse);
const encodeParticipantIdentitiesResponse = Schema.encodeEffect(ParticipantIdentitiesResponse);
const encodeOpenInboxCount = Schema.encodeEffect(OpenInboxCount);

/**
 * B6 declares the concrete paths and the authenticated J5 aggregate registers them.
 * Keeping the factory paths injectable makes the raw module testable without a
 * parallel composition seam.
 */
export interface ClientReadsHttpPaths {
  readonly participantHome: HttpRouter.PathInput;
  readonly participantIdentities: HttpRouter.PathInput;
  readonly openInboxCount: HttpRouter.PathInput;
}

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

const invalidRequest = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: "invalid_request", message }, { status: 400 });

const operationFailure = (error: unknown) => {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "ClientReadsError";
  const status =
    tag === "A2AParticipantNotFoundError" || tag === "A2ALocalOperatorNotFoundError"
      ? 404
      : tag === "A2AHumanPersonIdError"
        ? 400
        : 500;
  return HttpServerResponse.jsonUnsafe(
    {
      error: tag,
      message: error instanceof Error ? error.message : "Client read failed.",
    },
    { status },
  );
};

const jsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* Effect.result(request.json);
});

const respondHomes = (effect: Effect.Effect<ParticipantHomesResponse, ClientReadsError>) =>
  Effect.map(Effect.result(effect.pipe(Effect.flatMap(encodeParticipantHomesResponse))), (result) =>
    Result.isSuccess(result)
      ? HttpServerResponse.jsonUnsafe(result.success)
      : operationFailure(result.failure),
  );

const respondIdentities = (
  effect: Effect.Effect<ParticipantIdentitiesResponse, ClientReadsError>,
) =>
  Effect.map(
    Effect.result(effect.pipe(Effect.flatMap(encodeParticipantIdentitiesResponse))),
    (result) =>
      Result.isSuccess(result)
        ? HttpServerResponse.jsonUnsafe(result.success)
        : operationFailure(result.failure),
  );

const respondOpenInboxCount = (effect: Effect.Effect<OpenInboxCount, ClientReadsError>) =>
  Effect.map(Effect.result(effect.pipe(Effect.flatMap(encodeOpenInboxCount))), (result) =>
    Result.isSuccess(result)
      ? HttpServerResponse.jsonUnsafe(result.success)
      : operationFailure(result.failure),
  );

/**
 * Raw, authenticated J5 read routes registered through the J5 aggregate. This
 * module owns the already-settled method/body semantics and testable path slots.
 */
export const makeClientReadsHttpRouteLayer = (paths: ClientReadsHttpPaths) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const clientReads = yield* ClientReadsService;
      const homeRoute = HttpRouter.add(
        "POST",
        paths.participantHome,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.clientReads.participantHome");
          yield* authenticateRead;
          const body = yield* jsonBody;
          if (Result.isFailure(body)) return invalidRequest("The request body must be JSON.");
          const decoded = yield* Effect.result(decodeParticipantHomesRequest(body.success));
          if (Result.isFailure(decoded)) return invalidRequest("participantIds must be an array.");
          return yield* respondHomes(
            clientReads
              .participantHomes(decoded.success.participantIds)
              .pipe(Effect.map((entries) => ({ entries }))),
          );
        }).pipe(
          Effect.catchTags({
            EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
            EnvironmentInternalError: HttpServerRespondable.toResponse,
            EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
          }),
        ),
      );
      const identitiesRoute = HttpRouter.add(
        "POST",
        paths.participantIdentities,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.clientReads.participantIdentities");
          yield* authenticateRead;
          const body = yield* jsonBody;
          if (Result.isFailure(body)) return invalidRequest("The request body must be JSON.");
          const decoded = yield* Effect.result(decodeParticipantIdentitiesRequest(body.success));
          if (Result.isFailure(decoded)) return invalidRequest("participantIds must be an array.");
          return yield* respondIdentities(clientReads.participantIdentities(decoded.success));
        }).pipe(
          Effect.catchTags({
            EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
            EnvironmentInternalError: HttpServerRespondable.toResponse,
            EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
          }),
        ),
      );
      const countRoute = HttpRouter.add(
        "POST",
        paths.openInboxCount,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.clientReads.openInboxCount");
          yield* authenticateRead;
          const body = yield* jsonBody;
          if (Result.isFailure(body)) return invalidRequest("The request body must be JSON.");
          const decoded = yield* Effect.result(decodeOpenInboxCountRequest(body.success));
          if (Result.isFailure(decoded)) {
            return invalidRequest("personId must be omitted or a valid participant id.");
          }
          return yield* respondOpenInboxCount(clientReads.openInboxCount(decoded.success.personId));
        }).pipe(
          Effect.catchTags({
            EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
            EnvironmentInternalError: HttpServerRespondable.toResponse,
            EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
          }),
        ),
      );
      return Layer.mergeAll(homeRoute, identitiesRoute, countRoute);
    }),
  );

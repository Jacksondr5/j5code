import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId } from "@t3tools/contracts";
import {
  CrewRuntimeRequestRespondRequest,
  CrewRuntimeRequestRespondResponse,
  CrewRuntimeRequestsResponse,
  J5_API_PATHS,
} from "@t3tools/contracts/j5";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import {
  authenticateClientRead,
  authenticateOperate,
  invalidRequest,
  jsonBody,
} from "./ClientReadsHttp.ts";
import { CrewRuntimeRequestService } from "./CrewRuntimeRequestService.ts";

const encodeList = Schema.encodeEffect(CrewRuntimeRequestsResponse);
const decodeRespond = Schema.decodeUnknownEffect(CrewRuntimeRequestRespondRequest);
const encodeRespond = Schema.encodeEffect(CrewRuntimeRequestRespondResponse);

const authFailures = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

/**
 * The Inbox's Crew provider-request source: reading needs read scope like every Inbox read, and
 * answering needs operate scope like answering an ask. Answers are refused with 409 once the
 * request resolved, including after an inline answer on another device, and change nothing.
 */
export const makeCrewRuntimeRequestsHttpRouteLayer = (paths: {
  readonly list: HttpRouter.PathInput;
  readonly respond: HttpRouter.PathInput;
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const requests = yield* CrewRuntimeRequestService;
      const crypto = yield* Crypto.Crypto;
      const list = HttpRouter.add(
        "POST",
        paths.list,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.crews.runtimeRequests");
          yield* authenticateClientRead;
          const encoded = yield* Effect.result(
            requests.list.pipe(Effect.flatMap((items) => encodeList({ requests: items }))),
          );
          if (Result.isSuccess(encoded)) return HttpServerResponse.jsonUnsafe(encoded.success);
          yield* Effect.logError("J5 crew runtime request list failed", {
            cause: encoded.failure,
          });
          return HttpServerResponse.jsonUnsafe(
            { error: "CrewRuntimeRequestsReadError", message: "Reading crew requests failed." },
            { status: 500 },
          );
        }).pipe(Effect.catchTags(authFailures)),
      );
      const respond = HttpRouter.add(
        "POST",
        paths.respond,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.crews.runtimeRequests.respond");
          yield* authenticateOperate;
          const body = yield* jsonBody;
          if (Result.isFailure(body)) return invalidRequest("The request body must be JSON.");
          const decoded = yield* Effect.result(decodeRespond(body.success));
          if (Result.isFailure(decoded))
            return invalidRequest(
              "threadId and requestId are required, with a decision or answers.",
            );
          const answer = decoded.success;
          const commandId = CommandId.make(`j5-crew-runtime-request:${yield* crypto.randomUUIDv4}`);
          const outcome = yield* Effect.result(
            requests
              .respond({
                threadId: answer.threadId,
                requestId: answer.requestId,
                commandId,
                ...(answer.decision === undefined ? {} : { decision: answer.decision }),
                ...(answer.answers === undefined ? {} : { answers: answer.answers }),
              })
              .pipe(
                Effect.flatMap(() =>
                  encodeRespond({ threadId: answer.threadId, requestId: answer.requestId }),
                ),
              ),
          );
          if (Result.isSuccess(outcome)) return HttpServerResponse.jsonUnsafe(outcome.success);
          const failure = outcome.failure;
          const status =
            failure._tag === "CrewRuntimeRequestNotFoundError"
              ? 404
              : failure._tag === "CrewRuntimeRequestConflictError"
                ? 409
                : failure._tag === "CrewRuntimeRequestInvalidError"
                  ? 400
                  : 500;
          if (status === 500)
            yield* Effect.logError("J5 crew runtime request answer failed", { cause: failure });
          return HttpServerResponse.jsonUnsafe(
            {
              error: failure._tag,
              message: status === 500 ? "Answering the request failed." : failure.message,
            },
            { status },
          );
        }).pipe(Effect.catchTags(authFailures)),
      );
      return Layer.mergeAll(list, respond);
    }),
  );

// The authenticated aggregate carries no Crypto of its own; the route brings the Node one along.
export const crewRuntimeRequestsHttpRouteLayer = makeCrewRuntimeRequestsHttpRouteLayer({
  list: J5_API_PATHS.crewRuntimeRequests,
  respond: J5_API_PATHS.crewRuntimeRequestRespond,
}).pipe(Layer.provide(NodeCrypto.layer));

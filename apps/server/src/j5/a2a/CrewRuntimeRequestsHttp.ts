import { CrewRuntimeRequestsResponse, J5_API_PATHS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/http";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { authenticateClientRead } from "./ClientReadsHttp.ts";
import { CrewRuntimeRequestService } from "./CrewRuntimeRequestService.ts";

const encodeList = Schema.encodeEffect(CrewRuntimeRequestsResponse);

const authFailures = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

/**
 * The Inbox's source of Crew seat approvals: reading needs read scope like every Inbox read.
 * Answering one is an RPC (`clientActionRpc.ts`).
 */
export const makeCrewRuntimeRequestsHttpRouteLayer = (paths: {
  readonly list: HttpRouter.PathInput;
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const requests = yield* CrewRuntimeRequestService;
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
      return list;
    }),
  );

export const crewRuntimeRequestsHttpRouteLayer = makeCrewRuntimeRequestsHttpRouteLayer({
  list: J5_API_PATHS.crewRuntimeRequests,
});

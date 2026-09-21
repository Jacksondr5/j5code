import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import * as J5Contracts from "@t3tools/contracts/j5";

import { AgentCrewProposalService } from "./AgentCrewProposalService.ts";
import {
  authenticateClientRead,
  authenticateOperate,
  invalidRequest,
  jsonBody,
} from "./ClientReadsHttp.ts";
import { CrewProposalService } from "./CrewProposalService.ts";

export const CREW_PROPOSALS_PATH = "/api/j5/a2a/crews/proposals";
export const CREW_PROPOSAL_RESOLVE_PATH = "/api/j5/a2a/crews/proposals/resolve";

// The response and request shapes are the J5 contract the clients decode; aliased so the route's
// encode and the client's decode cannot drift.
const CrewProposalsResponse = J5Contracts.CrewProposalsResponse;
const CrewProposalResolveRequest = J5Contracts.CrewProposalResolveRequest;
const CrewProposalResolveResponse = J5Contracts.CrewProposalResolveResponse;

const encodeList = Schema.encodeEffect(CrewProposalsResponse);
const encodeResolve = Schema.encodeEffect(CrewProposalResolveResponse);
const decodeResolve = Schema.decodeUnknownEffect(CrewProposalResolveRequest);

const failureResponse = (cause: unknown) => {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String(cause._tag)
      : "CrewProposalError";
  const status =
    tag === "CrewProposalNotFoundError"
      ? 404
      : tag === "CrewProposalNotOpenError" || tag === "CrewProposalRequestError"
        ? 409
        : tag === "CrewLaunchSeatUnavailableError" ||
            tag === "CrewLaunchCapError" ||
            tag === "CrewLaunchSeatConflictError"
          ? 409
          : 500;
  const message =
    status === 500
      ? "Crew proposal operation failed."
      : cause instanceof Error
        ? cause.message
        : String(cause);
  const respond = Effect.succeed(
    HttpServerResponse.jsonUnsafe({ error: tag, message }, { status }),
  );
  return status === 500
    ? Effect.logError("J5 crew proposal operation failed", { cause }).pipe(Effect.andThen(respond))
    : respond;
};

/** Authenticated routes for the crew gate: list what awaits the human, and resolve one proposal. */
export const makeCrewProposalsHttpRouteLayer = (paths: {
  readonly list: HttpRouter.PathInput;
  readonly resolve: HttpRouter.PathInput;
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* AgentCrewProposalService;
      const gate = yield* CrewProposalService;
      const listRoute = HttpRouter.add(
        "POST",
        paths.list,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.crews.proposals.list");
          yield* authenticateClientRead;
          const read = yield* Effect.result(
            store.listOpen().pipe(Effect.flatMap((proposals) => encodeList({ proposals }))),
          );
          return Result.isSuccess(read)
            ? HttpServerResponse.jsonUnsafe(read.success)
            : yield* failureResponse(read.failure);
        }).pipe(
          Effect.catchTags({
            EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
            EnvironmentInternalError: HttpServerRespondable.toResponse,
            EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
          }),
        ),
      );
      const resolveRoute = HttpRouter.add(
        "POST",
        paths.resolve,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.crews.proposals.resolve");
          yield* authenticateOperate;
          const body = yield* jsonBody;
          if (Result.isFailure(body)) return invalidRequest("The request body must be JSON.");
          const decoded = yield* Effect.result(decodeResolve(body.success));
          if (Result.isFailure(decoded))
            return invalidRequest(
              "proposalId, decision (approve or decline), and optional seats are required.",
            );
          const outcome = yield* Effect.result(
            gate
              .resolve({
                proposalId: decoded.success.proposalId,
                decision: decoded.success.decision,
                seats: decoded.success.seats,
              })
              .pipe(
                Effect.flatMap((result) =>
                  encodeResolve({
                    proposal: result.proposal,
                    crewInstanceId: result.instance?.id ?? null,
                  }),
                ),
              ),
          );
          return Result.isSuccess(outcome)
            ? HttpServerResponse.jsonUnsafe(outcome.success)
            : yield* failureResponse(outcome.failure);
        }).pipe(
          Effect.catchTags({
            EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
            EnvironmentInternalError: HttpServerRespondable.toResponse,
            EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
          }),
        ),
      );
      return Layer.mergeAll(listRoute, resolveRoute);
    }),
  );

export const crewProposalsHttpRouteLayer = makeCrewProposalsHttpRouteLayer({
  list: CREW_PROPOSALS_PATH,
  resolve: CREW_PROPOSAL_RESOLVE_PATH,
});

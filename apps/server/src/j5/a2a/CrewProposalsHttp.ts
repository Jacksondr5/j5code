import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/http";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import * as J5Contracts from "@t3tools/contracts/j5";

import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { AgentCrewProposalService } from "./AgentCrewProposalService.ts";
import { authenticateClientRead } from "./ClientReadsHttp.ts";
import { projectCrewProposal } from "./crewProposalProjection.ts";

export const CREW_PROPOSALS_PATH = "/api/j5/a2a/crews/proposals";

// The response shape is the J5 contract the clients decode, so encode and decode cannot drift.
const encodeList = Schema.encodeEffect(J5Contracts.CrewProposalsResponse);

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
            tag === "CrewLaunchSeatConflictError" ||
            tag === "CrewStepAlreadyOwnedError"
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

/** The crew gate's read: every proposal that awaits the human. Resolving one is an RPC. */
export const makeCrewProposalsHttpRouteLayer = (paths: { readonly list: HttpRouter.PathInput }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* AgentCrewProposalService;
      const projectProposal = projectCrewProposal(yield* PlaybookStore);
      const listRoute = HttpRouter.add(
        "POST",
        paths.list,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.crews.proposals.list");
          yield* authenticateClientRead;
          const read = yield* Effect.result(
            store.listOpen().pipe(
              Effect.flatMap((open) => Effect.forEach(open, projectProposal)),
              Effect.flatMap((proposals) => encodeList({ proposals })),
            ),
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
      return listRoute;
    }),
  );

export const crewProposalsHttpRouteLayer = makeCrewProposalsHttpRouteLayer({
  list: CREW_PROPOSALS_PATH,
});

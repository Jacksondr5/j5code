import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId } from "@t3tools/contracts";
import { CrewStopRequest, CrewStopResponse } from "@t3tools/contracts/j5";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { authenticateOperate, invalidRequest, jsonBody } from "./ClientReadsHttp.ts";
import { CrewStopService } from "./CrewStopService.ts";
import { crewSeatRequestKey, lifecycleCommandId } from "./spawnIds.ts";

export const CREW_STOP_PATH = "/api/j5/a2a/crews/stop";
const HUMAN_STOP_SESSION = "j5-crew-stop-human";

const decodeStop = Schema.decodeUnknownEffect(CrewStopRequest);
const encodeStop = Schema.encodeEffect(CrewStopResponse);

/**
 * The person's Stop crew control (Fleet crew header, Captain's sidebar expander). Operate scope,
 * like answering an ask: the person is not a Crew participant, so there is no Captain check; the
 * service interrupts running seats and touches nothing else. Each click is one stop, keyed by a
 * fresh request id, so two clicks cannot share command ids.
 */
export const makeCrewStopHttpRouteLayer = (path: HttpRouter.PathInput) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const stops = yield* CrewStopService;
      const crypto = yield* Crypto.Crypto;
      return HttpRouter.add(
        "POST",
        path,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.crews.stop");
          yield* authenticateOperate;
          const body = yield* jsonBody;
          if (Result.isFailure(body)) return invalidRequest("The request body must be JSON.");
          const decoded = yield* Effect.result(decodeStop(body.success));
          if (Result.isFailure(decoded)) return invalidRequest("crewInstanceId is required.");
          const requestKey = yield* crypto.randomUUIDv4;
          const outcome = yield* Effect.result(
            stops
              .stop({
                callerParticipantId: null,
                squadronId: null,
                crewInstanceId: decoded.success.crewInstanceId,
                commandIds: (seatName) => ({
                  interruptCommandId: CommandId.make(
                    lifecycleCommandId({
                      providerSessionId: HUMAN_STOP_SESSION,
                      requestKey: crewSeatRequestKey(requestKey, seatName),
                      operation: "stop-crew-interrupt",
                    }),
                  ),
                }),
              })
              .pipe(
                Effect.flatMap((result) =>
                  encodeStop({
                    crewInstanceId: result.crewInstanceId,
                    // A seat whose thread never came to exist has no result a client knows.
                    members: result.members.flatMap((member) =>
                      member.result === "never_created"
                        ? []
                        : [
                            {
                              seat: member.seatName,
                              participantId: member.participantId,
                              result: member.result,
                            },
                          ],
                    ),
                  }),
                ),
              ),
          );
          if (Result.isSuccess(outcome)) return HttpServerResponse.jsonUnsafe(outcome.success);
          const failure = outcome.failure;
          const status =
            failure._tag === "CrewStopNotFoundError"
              ? 404
              : failure._tag === "CrewStopRequestError"
                ? 409
                : 500;
          if (status === 500) yield* Effect.logError("J5 crew stop failed", { cause: failure });
          return HttpServerResponse.jsonUnsafe(
            {
              error: failure._tag,
              message: status === 500 ? "Stopping the crew failed." : failure.message,
            },
            { status },
          );
        }).pipe(
          Effect.catchTags({
            EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
            EnvironmentInternalError: HttpServerRespondable.toResponse,
            EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
          }),
        ),
      );
    }),
  );

// The authenticated aggregate carries no Crypto of its own; the route brings the Node one along.
export const crewStopHttpRouteLayer = makeCrewStopHttpRouteLayer(CREW_STOP_PATH).pipe(
  Layer.provide(NodeCrypto.layer),
);

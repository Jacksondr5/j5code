import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CrewArchiveRequest, CrewArchiveResponse } from "@t3tools/contracts/j5";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { authenticateOperate, invalidRequest, jsonBody } from "./ClientReadsHttp.ts";
import { crewSeatRequestKey, lifecycleCommandId } from "./spawnIds.ts";

export const CREW_ARCHIVE_PATH = "/api/j5/a2a/crews/archive";
const HUMAN_ARCHIVE_SESSION = "j5-crew-archive-human";

const decodeArchive = Schema.decodeUnknownEffect(CrewArchiveRequest);
const encodeArchive = Schema.encodeEffect(CrewArchiveResponse);

/**
 * The person's Archive crew: the Fleet crew header, and the cascade when a Captain is archived
 * from the sidebar. The person is not a participant, so there is no Captain check, and the dialog
 * they confirmed already listed every seat's open asks and running turns, so the service runs with
 * its confirmation satisfied rather than minting a token nobody would read. Each click is one
 * archive keyed by a fresh request id; seats that already retired replay as already archived.
 */
export const makeCrewArchiveHttpRouteLayer = (path: HttpRouter.PathInput) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const archives = yield* ArchiveCrewService;
      const crypto = yield* Crypto.Crypto;
      return HttpRouter.add(
        "POST",
        path,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.crews.archive");
          yield* authenticateOperate;
          const body = yield* jsonBody;
          if (Result.isFailure(body)) return invalidRequest("The request body must be JSON.");
          const decoded = yield* Effect.result(decodeArchive(body.success));
          if (Result.isFailure(decoded)) return invalidRequest("crewInstanceId is required.");
          const requestKey = yield* crypto.randomUUIDv4;
          const archivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const crewInstanceId = decoded.success.crewInstanceId;
          const outcome = yield* Effect.result(
            archives
              .archive({
                providerSessionId: HUMAN_ARCHIVE_SESSION,
                callerParticipantId: null,
                squadronId: null,
                crewInstanceId,
                clientRequestKey: requestKey,
                confirmationSatisfied: true,
                archivedAt,
                commandIds: (seatName) => ({
                  interruptCommandId: lifecycleCommandId({
                    providerSessionId: HUMAN_ARCHIVE_SESSION,
                    requestKey: crewSeatRequestKey(requestKey, seatName),
                    operation: "archive-crew-interrupt",
                  }),
                  archiveCommandId: lifecycleCommandId({
                    providerSessionId: HUMAN_ARCHIVE_SESSION,
                    requestKey: crewSeatRequestKey(requestKey, seatName),
                    operation: "archive-crew-thread",
                  }),
                }),
              })
              .pipe(
                Effect.flatMap((result) =>
                  encodeArchive({
                    crewInstanceId,
                    status: result.status,
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
                    neverCreatedSeats: result.members
                      .filter((member) => member.result === "never_created")
                      .map((member) => member.seatName),
                  }),
                ),
              ),
          );
          if (Result.isSuccess(outcome)) return HttpServerResponse.jsonUnsafe(outcome.success);
          const failure = outcome.failure;
          const status =
            failure._tag === "ArchiveCrewNotFoundError"
              ? 404
              : failure._tag === "ArchiveCrewPartialFailureError"
                ? 500
                : 409;
          if (status === 500) yield* Effect.logError("J5 crew archive failed", { cause: failure });
          return HttpServerResponse.jsonUnsafe(
            {
              error: failure._tag,
              message:
                status === 500
                  ? "Archiving the crew stopped partway; the seats already retired stay retired. Try again."
                  : failure.message,
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
export const crewArchiveHttpRouteLayer = makeCrewArchiveHttpRouteLayer(CREW_ARCHIVE_PATH).pipe(
  Layer.provide(NodeCrypto.layer),
);

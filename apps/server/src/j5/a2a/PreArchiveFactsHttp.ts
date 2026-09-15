import { AuthOrchestrationReadScope, ThreadId } from "@t3tools/contracts";
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
import type { PreArchiveCrewSeat, PreArchiveLiveCrew } from "@t3tools/contracts/j5";

import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { ArchiveCrewService, type ArchiveCrewCaptainFacts } from "./ArchiveCrewService.ts";
import { A2AArchiveFacts, type ThreadPreArchiveFacts } from "./ArchiveFactsService.ts";
import type { ParticipantId } from "./contracts.ts";

export const PRE_ARCHIVE_FACTS_PATH = "/api/j5/a2a/pre-archive-facts";

const PreArchiveFactsRequest = Schema.Struct({ threadId: ThreadId });
const decodePreArchiveFactsRequest = Schema.decodeUnknownEffect(PreArchiveFactsRequest);

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

const requestFailure = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: "invalid_request", message }, { status: 400 });

const operationFailure = (cause: unknown) =>
  Effect.logError("J5 A2A pre-archive fact read failed", { cause }).pipe(
    Effect.as(
      HttpServerResponse.jsonUnsafe(
        {
          error:
            typeof cause === "object" && cause !== null && "_tag" in cause
              ? String(cause._tag)
              : "PreArchiveFactsReadError",
          message: "Pre-archive fact lookup failed.",
        },
        { status: 500 },
      ),
    ),
  );

/** What the dialog shows for a Crew the archived agent commands: each seat's consequences. */
const projectLiveCrew = (entry: ArchiveCrewCaptainFacts): PreArchiveLiveCrew => ({
  crewInstanceId: entry.instance.id,
  crewName: entry.instance.displayName,
  seats: entry.facts.members.map((member) => ({
    seat: member.seatName,
    participantId: member.participantId,
    runningTurn: member.facts.runningTurn !== null,
    openAsks: member.facts.openExchanges.length,
  })),
});

/**
 * AR2's human-facing, authenticated read; it performs no archive mutation. A registered agent's
 * facts carry its Crew relations, because a Captain is never archived alone and a seat is never
 * archived one by one (Crews AC16, AC17): `liveCrews` are the Crews it commands, seat by seat,
 * which the lifecycle cascade retires as units when the archive commits, and `crewSeat` is the
 * seat it holds, which the web refuses to archive alone. A failed Crew read is `null`, shown as
 * "couldn't check", never as no Crews.
 */
export const preArchiveFactsHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const archiveFacts = yield* A2AArchiveFacts;
    const archiveCrews = yield* ArchiveCrewService;
    const crews = yield* AgentCrewInstanceService;
    const readCrewSeat = (participantId: ParticipantId): Effect.Effect<PreArchiveCrewSeat | null> =>
      Effect.gen(function* () {
        const membership = yield* crews.findMembership(participantId);
        if (membership === null) return null;
        const instance = yield* crews.read(membership.crewInstanceId);
        if (instance === null || instance.archivedAt !== null) return null;
        return {
          crewInstanceId: instance.id,
          crewName: instance.displayName,
          seat: membership.seatName,
        };
      }).pipe(Effect.orElseSucceed(() => null));
    const withLiveCrews = (facts: ThreadPreArchiveFacts): Effect.Effect<object> =>
      facts.state !== "registered"
        ? Effect.succeed(facts)
        : Effect.all({
            liveCrews: archiveCrews
              .readCaptainFacts({
                squadronId: facts.squadronId,
                captainParticipantId: facts.participantId,
              })
              .pipe(
                Effect.map((entries) => entries.map(projectLiveCrew)),
                Effect.catchCause((cause) =>
                  Effect.logWarning("J5 A2A pre-archive crew read failed", { cause }).pipe(
                    Effect.as(null),
                  ),
                ),
              ),
            crewSeat: readCrewSeat(facts.participantId),
          }).pipe(Effect.map((crewFacts) => ({ ...facts, ...crewFacts })));
    const route = HttpRouter.add(
      "POST",
      PRE_ARCHIVE_FACTS_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.preArchiveFacts.read");
        yield* authenticateRead;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodePreArchiveFactsRequest(body.success));
        if (Result.isFailure(decoded)) return requestFailure("A valid threadId is required.");
        const result = yield* Effect.result(
          archiveFacts.readForThread(decoded.success.threadId).pipe(Effect.flatMap(withLiveCrews)),
        );
        if (Result.isSuccess(result)) return HttpServerResponse.jsonUnsafe(result.success);
        return yield* operationFailure(result.failure);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
    return route;
  }),
);

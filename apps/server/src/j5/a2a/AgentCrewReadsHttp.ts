import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as J5Contracts from "@t3tools/contracts/j5";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { authenticateClientRead, invalidRequest, jsonBody } from "./ClientReadsHttp.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";

export const CLIENT_READS_CREW_MEMBERSHIPS_PATH = "/api/j5/a2a/client-reads/crew-memberships";

// Shared with the clients through the J5 contract so encode and decode cannot drift.
export const ThreadCrewMembership = J5Contracts.ThreadCrewMembership;
export type ThreadCrewMembership = J5Contracts.ThreadCrewMembership;
export const CrewMembershipsRequest = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(500)),
});
export const CrewMembershipsResponse = J5Contracts.CrewMembershipsResponse;
export type CrewMembershipsResponse = typeof CrewMembershipsResponse.Type;

const decodeRequest = Schema.decodeUnknownEffect(CrewMembershipsRequest);
const encodeResponse = Schema.encodeEffect(CrewMembershipsResponse);

const crewRef = (instance: AgentCrewInstance) => ({
  crewInstanceId: instance.id,
  crewName: instance.displayName,
  archived: instance.archivedAt !== null,
});

/**
 * Pure projection: every requested thread that is a live member or a Captain gets one entry;
 * threads outside any Crew get none. A live member's entry wins over a captain's, since a member
 * cannot launch; a retired Crew's seat is a plain agent again, so its old membership never hides
 * the Crews that agent now commands.
 */
export const projectCrewMemberships = (
  threadIds: ReadonlyArray<ThreadId>,
  instances: ReadonlyArray<AgentCrewInstance>,
): CrewMembershipsResponse => {
  const entries: Array<CrewMembershipsResponse["entries"][number]> = [];
  for (const threadId of new Set(threadIds)) {
    const participantId = participantIdForThread(threadId);
    let member: ThreadCrewMembership | undefined;
    const commanded: Array<ReturnType<typeof crewRef>> = [];
    for (const instance of instances) {
      const seat =
        instance.archivedAt === null
          ? instance.members.find((candidate) => candidate.threadId === threadId)
          : undefined;
      if (seat !== undefined)
        member = { kind: "member", seat: seat.seatName, crew: crewRef(instance) };
      if (instance.captainParticipantId === participantId) commanded.push(crewRef(instance));
    }
    if (member !== undefined) entries.push({ threadId, membership: member });
    else if (commanded.length > 0)
      entries.push({ threadId, membership: { kind: "captain", crews: commanded } });
  }
  return { entries };
};

/** Authenticated J5 read for Sidebar crew chips; registered through the J5 route aggregate. */
export const makeAgentCrewReadsHttpRouteLayer = (path: HttpRouter.PathInput) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const crews = yield* AgentCrewInstanceService;
      return HttpRouter.add(
        "POST",
        path,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.clientReads.crewMemberships");
          yield* authenticateClientRead;
          const body = yield* jsonBody;
          if (Result.isFailure(body)) return invalidRequest("The request body must be JSON.");
          const decoded = yield* Effect.result(decodeRequest(body.success));
          if (Result.isFailure(decoded))
            return invalidRequest("threadIds must be an array of at most 500 thread ids.");
          const threadIds = decoded.success.threadIds;
          const read = yield* Effect.result(
            crews
              .listInvolving({
                threadIds,
                participantIds: threadIds.map(participantIdForThread),
              })
              .pipe(
                Effect.map((instances) => projectCrewMemberships(threadIds, instances)),
                Effect.flatMap(encodeResponse),
              ),
          );
          if (Result.isFailure(read)) {
            yield* Effect.logError("J5 crew membership read failed", { cause: read.failure });
            return HttpServerResponse.jsonUnsafe(
              { error: "AgentCrewReadError", message: "Crew membership read failed." },
              { status: 500 },
            );
          }
          return HttpServerResponse.jsonUnsafe(read.success);
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

export const agentCrewReadsHttpRouteLayer = makeAgentCrewReadsHttpRouteLayer(
  CLIENT_READS_CREW_MEMBERSHIPS_PATH,
);

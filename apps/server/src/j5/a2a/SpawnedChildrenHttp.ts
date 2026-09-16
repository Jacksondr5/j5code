import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as J5Contracts from "@t3tools/contracts/j5";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { authenticateClientRead, invalidRequest, jsonBody } from "./ClientReadsHttp.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ParticipantId } from "./contracts.ts";

export const CLIENT_READS_SPAWNED_CHILDREN_PATH = "/api/j5/a2a/client-reads/spawned-children";

const AGENT_PARTICIPANT_PREFIX = "agent:j5:a2a:";

/** The inverse of `participantIdForThread`; non-thread participants (humans) yield null. */
export const threadIdForParticipant = (participantId: string): ThreadId | null =>
  participantId.startsWith(AGENT_PARTICIPANT_PREFIX)
    ? ThreadId.make(participantId.slice(AGENT_PARTICIPANT_PREFIX.length))
    : null;

// Shared with the clients through the J5 contract so encode and decode cannot drift.
export const SpawnedChild = J5Contracts.SpawnedChild;
export const SpawnedChildrenRequest = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(500)),
});
export const SpawnedChildrenResponse = J5Contracts.SpawnedChildrenResponse;
export type SpawnedChildrenResponse = typeof SpawnedChildrenResponse.Type;

const decodeRequest = Schema.decodeUnknownEffect(SpawnedChildrenRequest);
const encodeResponse = Schema.encodeEffect(SpawnedChildrenResponse);

interface PlacementRow {
  readonly participant_id: string;
  readonly placement_parent_id: string;
}

/** Pure projection: placement rows keyed by parent, annotated with live Crew seats. Parents without children get no entry. */
export const projectSpawnedChildren = (
  threadIds: ReadonlyArray<ThreadId>,
  rows: ReadonlyArray<PlacementRow>,
  crews: ReadonlyArray<AgentCrewInstance>,
): SpawnedChildrenResponse => {
  const seats = new Map<string, NonNullable<typeof SpawnedChild.Type.seat>>();
  for (const crew of crews) {
    if (crew.archivedAt !== null) continue;
    for (const member of crew.members)
      seats.set(member.participantId, {
        crewInstanceId: crew.id,
        crewName: crew.displayName,
        seat: member.seatName,
      });
  }
  const entries: Array<SpawnedChildrenResponse["entries"][number]> = [];
  for (const threadId of new Set(threadIds)) {
    const parentId = participantIdForThread(threadId);
    const children = rows.flatMap((row) => {
      if (row.placement_parent_id !== parentId) return [];
      const childThreadId = threadIdForParticipant(row.participant_id);
      return childThreadId === null
        ? []
        : [
            {
              threadId: childThreadId,
              participantId: ParticipantId.make(row.participant_id),
              seat: seats.get(row.participant_id) ?? null,
            },
          ];
    });
    if (children.length > 0) entries.push({ threadId, children });
  }
  return { entries };
};

/**
 * Sidebar discovery read: the agents placed directly under each visible thread, so a Captain's
 * (or any spawner's) row can expand into the work it started. Placement is the J5 org tree;
 * upstream lineage children (subagents, forks) are not included here.
 */
export const makeSpawnedChildrenHttpRouteLayer = (path: HttpRouter.PathInput) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const crews = yield* AgentCrewInstanceService;
      return HttpRouter.add(
        "POST",
        path,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.clientReads.spawnedChildren");
          yield* authenticateClientRead;
          const body = yield* jsonBody;
          if (Result.isFailure(body)) return invalidRequest("The request body must be JSON.");
          const decoded = yield* Effect.result(decodeRequest(body.success));
          if (Result.isFailure(decoded))
            return invalidRequest("threadIds must be an array of at most 500 thread ids.");
          const threadIds = decoded.success.threadIds;
          const read = yield* Effect.result(
            Effect.gen(function* () {
              if (threadIds.length === 0) return { entries: [] } satisfies SpawnedChildrenResponse;
              const parentIds = [...new Set(threadIds.map(participantIdForThread))];
              // Retired children leave the expander as they leave the Fleet page: a membership
              // stamped archived_at (reversible archive) is not a live child.
              const rows = yield* sql<PlacementRow>`
                SELECT p.participant_id, p.placement_parent_id
                FROM j5_a2a_participant_placement p
                JOIN j5_a2a_squadron_membership m
                  ON m.squadron_id = p.squadron_id AND m.participant_id = p.participant_id
                WHERE p.placement_parent_id IN ${sql.in(parentIds)} AND m.archived_at IS NULL
              `;
              const childThreadIds = rows.flatMap((row) => {
                const id = threadIdForParticipant(row.participant_id);
                return id === null ? [] : [id];
              });
              const involved = yield* crews.listInvolving({
                threadIds: childThreadIds,
                participantIds: [],
              });
              return projectSpawnedChildren(threadIds, rows, involved);
            }).pipe(Effect.flatMap(encodeResponse)),
          );
          if (Result.isFailure(read)) {
            yield* Effect.logError("J5 spawned-children read failed", { cause: read.failure });
            return HttpServerResponse.jsonUnsafe(
              { error: "SpawnedChildrenReadError", message: "Spawned children read failed." },
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

export const spawnedChildrenHttpRouteLayer = makeSpawnedChildrenHttpRouteLayer(
  CLIENT_READS_SPAWNED_CHILDREN_PATH,
);

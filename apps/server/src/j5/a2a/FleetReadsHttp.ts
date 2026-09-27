import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as J5Contracts from "@t3tools/contracts/j5";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { authenticateClientRead, jsonBody } from "./ClientReadsHttp.ts";
import { A2ALedger } from "./LedgerService.ts";
import { ParticipantPlacementService } from "./PlacementService.ts";
import { SquadronId } from "./contracts.ts";
import type { ParticipantPlacementView } from "./placementContracts.ts";

export const CLIENT_READS_FLEET_PATH = "/api/j5/a2a/client-reads/fleet";

// The response shape is the J5 contract the clients decode; kept as aliases so the route's
// encode and the client's decode cannot drift.
export const FleetAgent = J5Contracts.FleetAgent;
export const FleetSquadron = J5Contracts.FleetSquadron;
export const FleetResponse = J5Contracts.FleetResponse;
export type FleetAgent = J5Contracts.FleetAgent;
export type FleetResponse = J5Contracts.FleetResponse;

const encodeResponse = Schema.encodeEffect(FleetResponse);
const decodeRequest = Schema.decodeUnknownEffect(J5Contracts.FleetReadRequest);

/** Pure projection from placement rows, live Crews, and open-ask counts to one Squadron. */
export const projectFleetSquadron = (input: {
  readonly squadron: { readonly id: SquadronId; readonly name: string };
  readonly participants: ReadonlyArray<ParticipantPlacementView>;
  readonly crews: ReadonlyArray<AgentCrewInstance>;
  readonly openAsks: ReadonlyMap<string, number>;
}): FleetResponse["squadrons"][number] => {
  const seatByParticipant = new Map<string, FleetAgent["crew"]>();
  for (const crew of input.crews) {
    if (crew.archivedAt !== null) continue;
    for (const member of crew.members) {
      seatByParticipant.set(member.participantId, {
        crewInstanceId: crew.id,
        crewName: crew.displayName,
        seat: member.seatName,
        captainParticipantId: crew.captainParticipantId,
      });
    }
  }
  // A retired agent is never a row (fleet-page AC11). An archive touches one agent, so a child
  // still live beneath it keeps its parent id and the client roots it; retired Crews read below.
  const agents = input.participants.filter(
    (row) => row.participant.kind === "agent" && row.archivedAt == null,
  );
  return {
    id: input.squadron.id,
    name: input.squadron.name,
    agents: agents.map((row) => ({
      participantId: row.participantId,
      threadId: row.threadId,
      displayName:
        "displayName" in row.participant && typeof row.participant.displayName === "string"
          ? row.participant.displayName
          : null,
      // Every agent-created path (spawn_agent, Crew seats, join_squadron) records a placement
      // at creation, so an agent with a Squadron home and no placement row is one a person
      // launched through the composer: `unrecorded` is that measured fact, not a guess. Recorded
      // `unknown` (a native thread that joined later) stays `?`.
      origin:
        row.provenance.kind === "spawned-by"
          ? "agent"
          : row.provenance.kind === "unknown"
            ? "unknown"
            : "human",
      placementParentId: row.placementParentId,
      crew: seatByParticipant.get(row.participantId) ?? null,
      openAsks: input.openAsks.get(row.participantId) ?? 0,
    })),
    // Archived Crews ride along with their roster snapshot: the brief, the seats, and who
    // approved each stay readable for whoever proposes the successor (Crews AC20).
    crews: input.crews.map((crew) => ({
      crewInstanceId: crew.id,
      crewName: crew.displayName,
      captainParticipantId: crew.captainParticipantId,
      captainThreadId: crew.captainThreadId,
      brief: crew.brief,
      version: crew.version,
      createdAt: crew.createdAt,
      archivedAt: crew.archivedAt,
      roster: crew.members.map((member) => ({
        seat: member.seatName,
        agentId: member.agentId,
        participantId: member.participantId,
        addedVersion: member.addedVersion,
        reason: member.reason,
      })),
    })),
  };
};

/**
 * The Roster read (SB6): every Squadron with its active agents, placement parents, Crew seats,
 * and the count of open asks each agent owes. Status and last activity come from the client's
 * thread state, so this read carries only what the ledger knows. Unknowns stay unknown.
 */
export const makeFleetReadsHttpRouteLayer = (path: HttpRouter.PathInput) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const placements = yield* ParticipantPlacementService;
      const crews = yield* AgentCrewInstanceService;
      const sql = yield* SqlClient.SqlClient;
      const readFleet = (includeRetired: boolean) =>
        Effect.gen(function* () {
          const squadrons = yield* ledger.listSquadrons();
          const result: Array<FleetResponse["squadrons"][number]> = [];
          for (const squadron of squadrons) {
            const participants = yield* placements.listParticipants(squadron.id);
            const agentIds = participants
              .filter((row) => row.participant.kind === "agent")
              .map((row) => row.participantId);
            const openAsks = new Map<string, number>();
            if (agentIds.length > 0) {
              const rows = yield* sql<{ readonly receiver_id: string; readonly count: number }>`
              SELECT receiver_id, COUNT(*) AS count FROM j5_a2a_exchange
              WHERE status = 'open' AND receiver_id IN ${sql.in([...agentIds])}
              GROUP BY receiver_id
            `;
              for (const row of rows) openAsks.set(row.receiver_id, Number(row.count));
            }
            result.push(
              projectFleetSquadron({
                squadron,
                participants,
                // Retired Crews carry rosters and briefs; only the page that shows them pays for them.
                crews: (yield* crews.listForSquadron(squadron.id)).filter(
                  (crew) => includeRetired || crew.archivedAt === null,
                ),
                openAsks,
              }),
            );
          }
          return { squadrons: result } satisfies FleetResponse;
        });
      return HttpRouter.add(
        "POST",
        path,
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest("j5.a2a.clientReads.fleet");
          yield* authenticateClientRead;
          const body = yield* jsonBody;
          const decoded = Result.isFailure(body)
            ? undefined
            : Result.getOrUndefined(yield* Effect.result(decodeRequest(body.success)));
          const read = yield* Effect.result(
            readFleet(decoded?.includeRetired === true).pipe(Effect.flatMap(encodeResponse)),
          );
          if (Result.isFailure(read)) {
            yield* Effect.logError("J5 fleet read failed", { cause: read.failure });
            return HttpServerResponse.jsonUnsafe(
              { error: "FleetReadError", message: "Fleet read failed." },
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

export const fleetReadsHttpRouteLayer = makeFleetReadsHttpRouteLayer(CLIENT_READS_FLEET_PATH);

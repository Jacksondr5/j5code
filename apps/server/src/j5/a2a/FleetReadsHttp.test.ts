import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import type { AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { projectFleetSquadron } from "./FleetReadsHttp.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";
import type { ParticipantPlacementView } from "./placementContracts.ts";

const squadronId = SquadronId.make("squadron:fleet");
const captainThread = ThreadId.make("thread:captain");
const builderThread = ThreadId.make("thread:builder");
const captain = participantIdForThread(captainThread);
const builder = participantIdForThread(builderThread);
const human = ParticipantId.make("human:fleet");

const agentRow = (
  participantId: ParticipantId,
  threadId: ThreadId,
  provenance: ParticipantPlacementView["provenance"],
  placementParentId: ParticipantId | null,
  archivedAt: string | null = null,
): ParticipantPlacementView => ({
  squadronId,
  participantId,
  participant: { kind: "agent", id: participantId, threadId },
  threadId,
  provenance,
  placementParentId,
  archivedAt,
});

const spawnedBy = (parent: ParticipantId): ParticipantPlacementView["provenance"] => ({
  kind: "spawned-by",
  spawnedByParticipantId: parent,
  source: "j5_spawn",
});

it("drops retired agents unless they hold the place of an active descendant", () => {
  const retiredCaptain = ParticipantId.make("agent:j5:a2a:retired-captain");
  const retiredSeat = ParticipantId.make("agent:j5:a2a:retired-seat");
  const projected = projectFleetSquadron({
    squadron: { id: squadronId, name: "Fleet" },
    participants: [
      // Archived, but its builder still works: a dimmed placeholder keeps the tree's shape.
      agentRow(
        retiredCaptain,
        ThreadId.make("t-rc"),
        { kind: "unrecorded" },
        null,
        "2026-09-14T20:00:00Z",
      ),
      agentRow(builder, builderThread, spawnedBy(retiredCaptain), retiredCaptain),
      // Archived with nothing active beneath it: not a row.
      agentRow(
        retiredSeat,
        ThreadId.make("t-rs"),
        spawnedBy(retiredCaptain),
        retiredCaptain,
        "2026-09-14T20:00:00Z",
      ),
      agentRow(captain, captainThread, { kind: "unrecorded" }, null),
    ],
    crews: [],
    openAsks: new Map(),
  });
  assert.deepStrictEqual(
    projected.agents.map((agent) => [agent.participantId, agent.archived]),
    [
      [retiredCaptain, true],
      [builder, false],
      [captain, false],
    ],
  );
});

const crew: AgentCrewInstance = {
  id: "crew:1",
  squadronId,
  captainParticipantId: captain,
  captainThreadId: captainThread,
  brief: "Implement and review the login fix.",
  version: 1,
  displayName: "Review Pair",
  createdAt: "2026-09-09T16:00:00.000Z",
  archivedAt: null,
  members: [
    {
      seatName: "builder",
      agentId: "builder",
      participantId: builder,
      threadId: builderThread,
      addedVersion: 1,
      reason: null,
    },
  ],
};

it("projects agents with origin, placement, crew seat, and owed asks; humans are omitted", () => {
  const projected = projectFleetSquadron({
    squadron: { id: squadronId, name: "Fleet" },
    participants: [
      // A person's own launch: homed, never placed, so no placement row exists.
      agentRow(captain, captainThread, { kind: "unrecorded" }, null),
      agentRow(
        builder,
        builderThread,
        { kind: "spawned-by", spawnedByParticipantId: captain, source: "j5_spawn" },
        captain,
      ),
      {
        squadronId,
        participantId: human,
        participant: { kind: "human", id: human, displayName: "Bryant" },
        threadId: null,
        provenance: { kind: "not-applicable" },
        placementParentId: null,
      } as ParticipantPlacementView,
    ],
    crews: [crew, { ...crew, id: "crew:old", archivedAt: "2026-09-09T18:00:00.000Z" }],
    openAsks: new Map([[builder, 2]]),
  });
  assert.deepStrictEqual(
    projected.agents.map((agent) => [
      agent.participantId,
      agent.origin,
      agent.placementParentId,
      agent.openAsks,
    ]),
    [
      [captain, "human", null, 0],
      [builder, "agent", captain, 2],
    ],
  );
  assert.deepStrictEqual(projected.agents[1]?.crew, {
    crewInstanceId: "crew:1",
    crewName: "Review Pair",
    seat: "builder",
    captainParticipantId: captain,
  });
  assert.isNull(projected.agents[0]?.crew);
  assert.deepStrictEqual(
    projected.crews.map((entry) => [entry.crewInstanceId, entry.archivedAt !== null]),
    [
      ["crew:1", false],
      ["crew:old", true],
    ],
  );
});

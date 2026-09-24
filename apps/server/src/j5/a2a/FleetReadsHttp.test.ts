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

it("drops retired agents; a live child keeps its parent id for the client to root", () => {
  const retiredCaptain = ParticipantId.make("agent:j5:a2a:retired-captain");
  const retiredSeat = ParticipantId.make("agent:j5:a2a:retired-seat");
  const projected = projectFleetSquadron({
    squadron: { id: squadronId, name: "Fleet" },
    participants: [
      agentRow(
        retiredCaptain,
        ThreadId.make("t-rc"),
        { kind: "unrecorded" },
        null,
        "2026-09-14T20:00:00Z",
      ),
      agentRow(builder, builderThread, spawnedBy(retiredCaptain), retiredCaptain),
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
    projected.agents.map((agent) => [agent.participantId, agent.placementParentId]),
    [
      [builder, retiredCaptain],
      [captain, null],
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

it("keeps every live roster seat: one with no ledger row rides under its Captain with no thread", () => {
  const critic = participantIdForThread(ThreadId.make("thread:critic"));
  const retiredSeat = participantIdForThread(ThreadId.make("thread:retired-seat"));
  const seat = (seatName: string, participantId: ParticipantId) => ({
    seatName,
    agentId: null,
    participantId,
    threadId: ThreadId.make(`thread:${seatName}`),
    addedVersion: 1,
    reason: null,
  });
  const projected = projectFleetSquadron({
    squadron: { id: squadronId, name: "Fleet" },
    participants: [
      agentRow(captain, captainThread, { kind: "unrecorded" }, null),
      agentRow(builder, builderThread, spawnedBy(captain), captain),
      agentRow(
        retiredSeat,
        ThreadId.make("thread:retired-seat"),
        spawnedBy(captain),
        captain,
        "2026-09-14T20:00:00Z",
      ),
    ],
    crews: [
      {
        ...crew,
        members: [...crew.members, seat("critic", critic), seat("retired", retiredSeat)],
      },
      // A retired Crew's never-created seats are not rows.
      {
        ...crew,
        id: "crew:old",
        archivedAt: "2026-09-09T18:00:00.000Z",
        members: [seat("ghost", ParticipantId.make("agent:j5:a2a:ghost"))],
      },
    ],
    openAsks: new Map(),
  });
  assert.deepStrictEqual(
    projected.agents.map((agent) => [agent.participantId, agent.threadId, agent.placementParentId]),
    [
      [captain, captainThread, null],
      [builder, builderThread, captain],
      [critic, null, captain],
    ],
  );
  assert.deepStrictEqual(projected.agents[2], {
    participantId: critic,
    threadId: null,
    displayName: "critic",
    origin: "agent",
    placementParentId: captain,
    crew: {
      crewInstanceId: "crew:1",
      crewName: "Review Pair",
      seat: "critic",
      captainParticipantId: captain,
    },
    openAsks: 0,
  });
});

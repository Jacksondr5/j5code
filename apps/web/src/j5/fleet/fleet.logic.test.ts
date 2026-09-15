import { describe, expect, it } from "vite-plus/test";

import { buildFleetTree, countFleetAlerts, originLabel } from "./fleet.logic";
import type { FleetAgent, FleetSquadron } from "./fleetClient";

const agent = (participantId: string, overrides: Partial<FleetAgent> = {}): FleetAgent => ({
  participantId,
  threadId: `thread:${participantId}`,
  displayName: participantId,
  origin: "human",
  archived: false,
  placementParentId: null,
  crew: null,
  openAsks: 0,
  ...overrides,
});
const seat = (seatName: string, captain: string) => ({
  crewInstanceId: "crew:1",
  crewName: "Review Pair",
  seat: seatName,
  captainParticipantId: captain,
});

describe("fleet tree", () => {
  const squadron: FleetSquadron = {
    id: "squadron:alpha",
    name: "Alpha",
    crews: [],
    agents: [
      agent("captain"),
      agent("critic", {
        placementParentId: "captain",
        origin: "agent",
        crew: seat("critic", "captain"),
      }),
      agent("builder", {
        placementParentId: "captain",
        origin: "agent",
        crew: seat("builder", "captain"),
        openAsks: 1,
      }),
      agent("helper", { placementParentId: "captain", origin: "agent" }),
      agent("aide", { placementParentId: "critic", origin: "agent" }),
      agent("orphan", { placementParentId: "gone", origin: "agent" }),
      agent("zed"),
    ],
  };

  it("groups crew members under their captain and keeps other children as plain rows", () => {
    const roots = buildFleetTree(squadron);
    expect(roots.map((node) => node.row.agent.participantId)).toEqual(["captain", "orphan", "zed"]);
    const captain = roots[0]!;
    expect(captain.crews).toHaveLength(1);
    expect(captain.crews[0]?.crewName).toBe("Review Pair");
    expect(
      captain.crews[0]?.members.map((node) => [node.row.agent.participantId, node.row.depth]),
    ).toEqual([
      ["builder", 2],
      ["critic", 2],
    ]);
    // A helper an agent placed under a seat stays beneath that seat instead of surfacing as a root.
    const critic = captain.crews[0]?.members[1];
    expect(critic?.row.crewInstanceId).toBe("crew:1");
    expect(critic?.children.map((node) => [node.row.agent.participantId, node.row.depth])).toEqual([
      ["aide", 3],
    ]);
    expect(captain.children.map((node) => [node.row.agent.participantId, node.row.depth])).toEqual([
      ["helper", 1],
    ]);
  });

  it("never loops on a cyclic placement and counts alerts from owed asks only", () => {
    const cyclic: FleetSquadron = {
      ...squadron,
      agents: [agent("a", { placementParentId: "b" }), agent("b", { placementParentId: "a" })],
    };
    const roots = buildFleetTree(cyclic);
    expect(roots.map((node) => node.row.agent.participantId).length).toBeGreaterThan(0);
    expect(countFleetAlerts([squadron])).toBe(1);
    expect(originLabel("unknown")).toBe("?");
  });
});

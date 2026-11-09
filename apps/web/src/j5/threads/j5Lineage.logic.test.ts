import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";
import type { FleetAgent, FleetProject } from "@t3tools/contracts/j5";

import { deriveJ5LineageRows } from "./j5Lineage.logic";

const agent = (participantId: string, overrides: Partial<FleetAgent> = {}): FleetAgent => ({
  participantId,
  threadId: `t-${participantId}`,
  displayName: participantId,
  origin: "human",
  placementParentId: null,
  crew: null,
  openAsks: 0,
  ...overrides,
});
const seat = (seatName: string, captain = "captain") => ({
  crewInstanceId: "crew-1",
  crewName: "Lineage",
  seat: seatName,
  captainParticipantId: captain,
});
const project = (agents: ReadonlyArray<FleetAgent>): FleetProject => ({
  id: "p",
  title: "P",
  agents,
  crews: [],
});
const rows = (projects: ReadonlyArray<FleetProject>, participantId: string) =>
  deriveJ5LineageRows(projects, ThreadId.make(`t-${participantId}`)).map(
    ({ threadId, role, crew }) => ({ threadId: threadId as string, role, seat: crew?.seat }),
  );

describe("deriveJ5LineageRows", () => {
  // The Captain is the builder's placement parent; the reviewer was re-placed under the builder.
  const roster = [
    project([
      agent("captain"),
      agent("builder", { origin: "agent", placementParentId: "captain", crew: seat("builder") }),
      agent("reviewer", { origin: "agent", placementParentId: "builder", crew: seat("reviewer") }),
      agent("peer", { origin: "agent", placementParentId: "captain" }),
      // A person-made thread someone placed under the peer: placement, not provenance, counts.
      agent("adopted", { origin: "human", placementParentId: "peer" }),
      // An unrecorded seat has no thread to open.
      agent("reserved", { threadId: null, placementParentId: "captain", crew: seat("tester") }),
    ]),
  ];

  it("lists a Captain's seats, re-placed ones included, before its solo peers", () => {
    expect(rows(roster, "captain")).toEqual([
      { threadId: "t-builder", role: "seat", seat: "builder" },
      { threadId: "t-reviewer", role: "seat", seat: "reviewer" },
      { threadId: "t-peer", role: "peer", seat: undefined },
    ]);
  });

  it("gives a re-placed seat its placement parent and its Captain", () => {
    expect(rows(roster, "reviewer")).toEqual([
      { threadId: "t-builder", role: "parent", seat: undefined },
      { threadId: "t-captain", role: "captain", seat: null },
    ]);
    expect(rows(roster, "builder")).toEqual([
      { threadId: "t-captain", role: "captain", seat: null },
      { threadId: "t-reviewer", role: "seat", seat: "reviewer" },
    ]);
  });

  it("follows placement for a person-made thread placed under an agent", () => {
    expect(rows(roster, "adopted")).toEqual([
      { threadId: "t-peer", role: "parent", seat: undefined },
    ]);
    expect(rows(roster, "peer")).toEqual([
      { threadId: "t-captain", role: "parent", seat: undefined },
      { threadId: "t-adopted", role: "peer", seat: undefined },
    ]);
  });

  it("resolves a parent recorded in another project of the same environment", () => {
    const split = [
      project([agent("captain")]),
      project([agent("peer", { origin: "agent", placementParentId: "captain" })]),
    ];
    expect(rows(split, "peer")).toEqual([
      { threadId: "t-captain", role: "parent", seat: undefined },
    ]);
  });

  it("shows nothing for a thread outside the roster or with no placement", () => {
    expect(rows(roster, "stranger")).toEqual([]);
    expect(rows([project([agent("solo")])], "solo")).toEqual([]);
  });
});

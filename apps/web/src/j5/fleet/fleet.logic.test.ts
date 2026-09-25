import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import { formatCrewStateSummary, summarizeCrewState, type CrewSeatThread } from "../crew/crewState";
import {
  buildFleetTree,
  countFleetAlerts,
  fleetInvolvedThreadRefs,
  originLabel,
  partitionFleet,
  retiredCrews,
} from "./fleet.logic";
import type { FleetAgent, FleetCrew, FleetSquadron } from "./fleetClient";

const agent = (participantId: string, overrides: Partial<FleetAgent> = {}): FleetAgent => ({
  participantId,
  threadId: `thread:${participantId}`,
  displayName: participantId,
  origin: "human",
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

describe("fleet involvement", () => {
  it("names seats, their Captains, and spawners with placed children, once each, per environment", () => {
    const environmentId = EnvironmentId.make("env:a");
    const refs = fleetInvolvedThreadRefs([
      {
        id: "squadron:alpha",
        name: "Alpha",
        crews: [],
        environmentId,
        agents: [
          agent("captain"),
          agent("builder", { placementParentId: "captain", crew: seat("builder", "captain") }),
          agent("critic", { placementParentId: "captain", crew: seat("critic", "captain") }),
          // A plain spawner with one placed child, and the child itself is not involved.
          agent("spawner"),
          agent("helper", { placementParentId: "spawner" }),
          // Human-created rows with no Crew and no children are never re-read on the poll.
          agent("solo"),
          // A seat whose thread is unknown cannot name a row.
          agent("ghost", { threadId: null, crew: seat("ghost", "captain") }),
        ],
      },
    ]);
    expect(refs.map((ref) => [ref.environmentId, ref.threadId]).toSorted()).toEqual([
      ["env:a", "thread:builder"],
      ["env:a", "thread:captain"],
      ["env:a", "thread:critic"],
      ["env:a", "thread:spawner"],
    ]);
  });
});

const crew = (id: string, archivedAt: string | null): FleetCrew => ({
  crewInstanceId: id,
  crewName: id,
  captainParticipantId: "captain",
  captainThreadId: "thread:captain",
  brief: "Land the PR.",
  version: 1,
  createdAt: "2026-09-14T09:00:00.000Z",
  archivedAt,
  roster: [],
});

describe("retired crews", () => {
  it("lists archived Crews of every Squadron, newest retirement first, each naming its Squadron", () => {
    const alpha: FleetSquadron = {
      id: "squadron:alpha",
      name: "Alpha",
      agents: [],
      crews: [
        crew("live", null),
        crew("older", "2026-09-14T10:00:00.000Z"),
        crew("newest", "2026-09-14T14:00:00.000Z"),
      ],
    };
    const beta: FleetSquadron = {
      id: "squadron:beta",
      name: "Beta",
      agents: [],
      crews: [crew("newer", "2026-09-14T12:00:00.000Z")],
    };
    expect(
      retiredCrews([alpha, beta]).map((entry) => [entry.crew.crewInstanceId, entry.squadron.name]),
    ).toEqual([
      ["newest", "Alpha"],
      ["newer", "Beta"],
      ["older", "Alpha"],
    ]);
  });
});

describe("fleet sections", () => {
  const environmentId = EnvironmentId.make("env:a");
  const shell = (overrides: Partial<CrewSeatThread> = {}): CrewSeatThread => ({
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    updatedAt: "2026-09-22T09:00:00.000Z",
    ...overrides,
  });
  const settled = shell({ settledAt: "2026-09-22T08:00:00.000Z" });
  const idle = shell();
  const running = shell({ runtime: { status: "running" } });
  // Test agents' thread ids are `thread:<participantId>`, so shells are keyed by participant.
  const lookupFrom =
    (shells: Record<string, CrewSeatThread | undefined>) => (_: EnvironmentId, threadId: string) =>
      shells[threadId.replace(/^thread:/, "")];
  const squadron = (id: string, agents: ReadonlyArray<FleetAgent>) => ({
    id: `squadron:${id}`,
    name: id,
    crews: [],
    agents,
    environmentId,
  });
  const roots = (rows: ReturnType<typeof partitionFleet>["active"]) =>
    rows.map(({ squadron: s, node }) => `${s.name}/${node.row.agent.participantId}`);

  it("places a settled agent under Settled and an idle or unknown one under Active", () => {
    const sections = partitionFleet(
      [squadron("Alpha", [agent("done"), agent("quiet"), agent("unseen"), agent("busy")])],
      lookupFrom({ done: settled, quiet: idle, busy: running }),
    );
    expect(roots(sections.active)).toEqual(["Alpha/busy", "Alpha/quiet", "Alpha/unseen"]);
    expect(roots(sections.settled)).toEqual(["Alpha/done"]);
    expect(sections.settledAgentCount).toBe(1);
    expect(sections.agentCount).toBe(4);
  });

  it("places the child of a retired agent at the root in its own section", () => {
    // The roster read leaves the retired parent out; its child keeps the parent id.
    const sections = partitionFleet(
      [squadron("Alpha", [agent("child", { placementParentId: "gone" }), agent("done")])],
      lookupFrom({ child: running, done: settled }),
    );
    expect(roots(sections.active)).toEqual(["Alpha/child"]);
    expect(sections.active[0]?.node.row.depth).toBe(0);
    expect(roots(sections.settled)).toEqual(["Alpha/done"]);
    expect(sections.agentCount).toBe(2);
  });

  it("moves a Crew as one unit when its Captain and every seat are settled", () => {
    const sections = partitionFleet(
      [
        squadron("Alpha", [
          agent("captain"),
          agent("builder", { placementParentId: "captain", crew: seat("builder", "captain") }),
          agent("critic", { placementParentId: "captain", crew: seat("critic", "captain") }),
        ]),
      ],
      lookupFrom({ captain: settled, builder: settled, critic: settled }),
    );
    expect(roots(sections.active)).toEqual([]);
    expect(roots(sections.settled)).toEqual(["Alpha/captain"]);
    // The Crew group travels with its Captain, seats intact, so Archive crew still has its seats.
    expect(
      sections.settled[0]?.node.crews[0]?.members.map((m) => m.row.agent.participantId),
    ).toEqual(["builder", "critic"]);
    expect(sections.settledAgentCount).toBe(3);
  });

  it("keeps a mixed subtree in Active: a settled root with one working seat or child is not done", () => {
    const agents = [
      agent("captain"),
      agent("builder", { placementParentId: "captain", crew: seat("builder", "captain") }),
      agent("critic", { placementParentId: "captain", crew: seat("critic", "captain") }),
      agent("helper", { placementParentId: "captain" }),
    ];
    const seatWorking = partitionFleet(
      [squadron("Alpha", agents)],
      lookupFrom({ captain: settled, builder: settled, critic: running, helper: settled }),
    );
    expect(roots(seatWorking.active)).toEqual(["Alpha/captain"]);
    expect(seatWorking.settled).toEqual([]);
    expect(seatWorking.settledAgentCount).toBe(0);
    const childIdle = partitionFleet(
      [squadron("Alpha", agents)],
      lookupFrom({ captain: settled, builder: settled, critic: settled, helper: idle }),
    );
    expect(roots(childIdle.active)).toEqual(["Alpha/captain"]);
    // A seat the client cannot see is not assumed done either.
    const seatUnknown = partitionFleet(
      [squadron("Alpha", agents)],
      lookupFrom({ captain: settled, builder: settled, helper: settled }),
    );
    expect(roots(seatUnknown.active)).toEqual(["Alpha/captain"]);
  });

  it("merges every Squadron in source order and never re-sorts by state", () => {
    const sections = partitionFleet(
      [
        squadron("Alpha", [agent("a-done"), agent("a-busy")]),
        squadron("Beta", [agent("b-busy"), agent("b-done")]),
      ],
      lookupFrom({ "a-done": settled, "a-busy": idle, "b-busy": running, "b-done": settled }),
    );
    expect(roots(sections.active)).toEqual(["Alpha/a-busy", "Beta/b-busy"]);
    expect(roots(sections.settled)).toEqual(["Alpha/a-done", "Beta/b-done"]);
  });
});

describe("roster seats without thread facts", () => {
  const environmentId = EnvironmentId.make("env:a");
  // The read carries a never-created seat with no thread, and a recorded seat may not be placed yet.
  const squadron: FleetSquadron = {
    id: "squadron:roster",
    name: "Roster",
    crews: [],
    agents: [
      agent("captain"),
      agent("builder", { placementParentId: "captain", crew: seat("builder", "captain") }),
      agent("critic", { threadId: null, origin: "agent", crew: seat("critic", "captain") }),
      agent("scout", { crew: seat("scout", "captain") }),
    ],
  };
  const settledShell: CrewSeatThread = {
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    archivedAt: null,
    settledOverride: "settled",
    updatedAt: "2026-09-09T10:00:00Z",
  };

  it("hangs every roster seat under its Captain, placed or not, and counts the unknown ones", () => {
    const [captain, ...rest] = buildFleetTree(squadron);
    expect(rest).toEqual([]);
    const members = captain!.crews[0]!.members.map((node) => node.row.agent);
    expect(members.map((member) => member.participantId)).toEqual(["builder", "critic", "scout"]);
    const shells = new Map([["thread:builder", settledShell]]);
    const summary = summarizeCrewState(
      members.map((member) => (member.threadId === null ? undefined : shells.get(member.threadId))),
    );
    expect(formatCrewStateSummary(summary)).toBe("1 settled · 2 unknown");
    expect(summary.total).toBe(3);
  });

  it("keeps a Crew with no placed seat as a named group with its count", () => {
    const [captain] = buildFleetTree({
      ...squadron,
      agents: [
        agent("captain"),
        agent("critic", { threadId: null, origin: "agent", crew: seat("critic", "captain") }),
      ],
    });
    expect(captain!.crews.map((crew) => [crew.crewName, crew.members.length])).toEqual([
      ["Review Pair", 1],
    ]);
  });

  it("reads each environment's shells for its own rows when thread ids collide", () => {
    const other = EnvironmentId.make("env:b");
    const solo = { id: "squadron:solo", name: "Solo", crews: [], agents: [agent("x")] };
    const sections = partitionFleet(
      [
        { ...solo, environmentId },
        { ...solo, environmentId: other },
      ],
      (env, threadId) =>
        env === environmentId && threadId === "thread:x" ? settledShell : undefined,
    );
    expect(sections.settled.map((row) => row.squadron.environmentId)).toEqual([environmentId]);
    expect(sections.active.map((row) => row.squadron.environmentId)).toEqual([other]);
  });
});

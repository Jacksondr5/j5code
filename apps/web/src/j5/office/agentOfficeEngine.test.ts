import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it, vi } from "vite-plus/test";
import { createOffice, officeRoster, type Lane } from "./agentOfficeEngine";
import { officeLayout } from "./officeLayout";

vi.mock("./officeSheetAssets", () => ({ drawEmployee: vi.fn(), drawOfficePiece: vi.fn() }));

const worker: Lane = {
  id: "worker",
  label: "Frontend",
  role: "terminal",
  slot: 0,
  status: "working",
  color: "#72b7a2",
  hair: "#5a3a22",
  pants: "#3d4668",
  bubbleText: "Implementing the view",
};

describe("office composition", () => {
  it.each([
    [320, 320],
    [390, 800],
    [1056, 624],
    [1400, 420],
    [480, 1000],
  ])("keeps stations reachable at %i x %i", (width, height) => {
    for (const count of [0, 6, 12, 22]) {
      const layout = officeLayout(width, height, count);
      const office = createOffice(layout);
      expect(layout.map.every((row) => row.length === layout.columns)).toBe(true);
      const workstations = [...layout.desks, ...layout.researchTables];
      expect(new Set(workstations.map(String)).size).toBe(workstations.length);
      // Every agent has a desk, and research tables are roughly a quarter of all seats.
      expect(layout.desks.length).toBeGreaterThanOrEqual(Math.min(22, count));
      expect(layout.researchTables.length).toBeGreaterThanOrEqual(1);
      expect(layout.researchTables.length).toBeLessThanOrEqual(layout.desks.length);
      const stations = [
        ...layout.desks,
        layout.boss,
        ...layout.researchTables,
        ...layout.cafeSeats.map((seat) => seat.tile),
      ];
      for (const tile of stations) {
        expect(office.bfs(layout.entry, tile).length, `unreachable ${tile}`).toBeGreaterThan(0);
        expect(layout.map[tile[1]]![tile[0]]).toMatch(/[.,o]/);
      }
      for (let i = 1; i < layout.desks.length; i += 1) {
        const previous = layout.desks[i - 1]!;
        const current = layout.desks[i]!;
        if (previous[1] === current[1]) expect(current[0] - previous[0]).toBe(5);
      }
    }
  });

  it("adds a separate meeting area only when there is room", () => {
    expect(officeLayout(390, 800, 6).meeting).toBeNull();
    const layout = officeLayout(1056, 624, 6);
    const meeting = layout.meeting!;
    expect(meeting).not.toBeNull();
    expect(layout.map[meeting[1]]!.slice(meeting[0], meeting[0] + 4)).toBe("MMMM");
  });
});

describe("office layout bounds", () => {
  it("never explodes the grid for a wide, short host", () => {
    const layout = officeLayout(2560, 1, 22);
    expect(layout.columns).toBeLessThanOrEqual(60);
    expect(layout.rows).toBeLessThanOrEqual(80);
    expect(officeLayout(1200, 1, 0).columns).toBeLessThanOrEqual(60);
  });
});

function subagent(overrides: Partial<RuntimeSubagent> & { id: string }): RuntimeSubagent {
  return {
    kind: "subagent",
    title: `Subagent: ${overrides.id}`,
    role: null,
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    childThreadId: null,
    firstSeenAt: "2026-09-21T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

function panelModel(agents: RuntimeSubagent[]): AgentPanelModel {
  return {
    workflows: [],
    directAgents: agents,
    runningCount: 0,
    waitingCount: 0,
    idleCount: 0,
    settledCount: 0,
    totalTokens: 0,
    hasAgents: agents.length > 0,
    liveCount: 0,
  };
}

describe("office roster", () => {
  it("maps runtime status onto office states and strips the Subagent prefix", () => {
    const { lanes, omitted } = officeRoster(
      panelModel([
        subagent({ id: "a", status: "pending" }),
        subagent({ id: "b", status: "running", progress: "npm install" }),
        subagent({ id: "c", status: "completed" }),
        subagent({ id: "d", status: "failed" }),
      ]),
    );
    expect(omitted).toBe(0);
    expect(lanes.map((lane) => [lane.id, lane.status, lane.label])).toEqual([
      ["a", "pending", "a"],
      ["b", "working", "b"],
      ["c", "departing", "c"],
      ["d", "failed", "d"],
    ]);
    expect(lanes[1]!.role).toBe("terminal");
  });

  it("admits live agents ahead of finished ones under the cap and reports the rest", () => {
    const finished = Array.from({ length: 22 }, (_, i) =>
      subagent({ id: `done-${i}`, status: "completed" }),
    );
    const { lanes, omitted } = officeRoster(
      panelModel([...finished, subagent({ id: "live", status: "running" })]),
    );
    expect(lanes).toHaveLength(22);
    expect(lanes.some((lane) => lane.id === "live")).toBe(true);
    expect(omitted).toBe(1);
  });

  it("keeps slots in model order so a status change does not renumber anyone", () => {
    const before = officeRoster(
      panelModel([subagent({ id: "a" }), subagent({ id: "b" }), subagent({ id: "c" })]),
    ).lanes;
    const after = officeRoster(
      panelModel([
        subagent({ id: "a", status: "waiting" }),
        subagent({ id: "b" }),
        subagent({ id: "c" }),
      ]),
    ).lanes;
    expect(after.map((lane) => [lane.id, lane.slot])).toEqual(
      before.map((lane) => [lane.id, lane.slot]),
    );
  });
});

describe("desk allocation", () => {
  it.each([3, 5, 22])("seats %i agents at %i distinct desks via the real roster path", (n) => {
    const { lanes } = officeRoster(
      panelModel(Array.from({ length: n }, (_, i) => subagent({ id: `a${i}` }))),
    );
    const office = createOffice(officeLayout(1056, 624, lanes.length));
    const sim = office.createSimulation();
    for (let frame = 0; frame < 4000; frame += 1) office.updateActors(sim, lanes, frame * 16);
    const tiles = lanes.map((lane) => String(sim.actors.get(lane.id)!.tile));
    expect(new Set(tiles).size).toBe(n);
    for (const lane of lanes) expect(sim.actors.get(lane.id)!.seated).toBe(true);
  });

  it("keeps everyone at their desk when one agent's status changes", () => {
    const working = officeRoster(
      panelModel([subagent({ id: "a" }), subagent({ id: "b" }), subagent({ id: "c" })]),
    ).lanes;
    const office = createOffice(officeLayout(1056, 624, working.length));
    const sim = office.createSimulation();
    for (let frame = 0; frame < 3000; frame += 1) office.updateActors(sim, working, frame * 16);
    const before = new Map(working.map((lane) => [lane.id, String(sim.actors.get(lane.id)!.tile)]));
    const flipped = officeRoster(
      panelModel([
        subagent({ id: "a", status: "waiting" }),
        subagent({ id: "b" }),
        subagent({ id: "c" }),
      ]),
    ).lanes;
    for (let frame = 0; frame < 600; frame += 1) {
      office.updateActors(sim, flipped, 60_000 + frame * 16);
      for (const lane of flipped) {
        expect(String(sim.actors.get(lane.id)!.tile)).toBe(before.get(lane.id));
        expect(sim.actors.get(lane.id)!.moving).toBe(false);
      }
    }
  });
});

describe("research tables", () => {
  it("seats researchers at research tables, overflow at desks, without reshuffling", () => {
    const office = createOffice(officeLayout(1056, 624, 6));
    const tables = office.layout.researchTables;
    expect(tables).toHaveLength(2);
    const sim = office.createSimulation();
    const readers: Lane[] = [0, 1, 2].map((slot) => ({
      ...worker,
      id: `r${slot}`,
      slot,
      role: "researcher",
    }));
    for (let frame = 0; frame < 2400; frame += 1) office.updateActors(sim, readers, frame * 16);
    expect(sim.actors.get("r0")!.tile).toEqual(tables[0]);
    expect(sim.actors.get("r1")!.tile).toEqual(tables[1]);
    expect(sim.actors.get("r1")!.seated).toBe(true);
    expect(sim.actors.get("r2")!.tile).toEqual(office.layout.desks[2]);
    // The first reader stops researching: it returns to its desk, the overflow
    // researcher takes the freed table, and the seated reader stays put.
    const next: Lane[] = [{ ...readers[0]!, role: "terminal" }, readers[1]!, readers[2]!];
    for (let frame = 0; frame < 2400; frame += 1) {
      office.updateActors(sim, next, 40_000 + frame * 16);
    }
    expect(sim.actors.get("r0")!.tile).toEqual(office.layout.desks[0]);
    expect(sim.actors.get("r1")!.tile).toEqual(tables[1]);
    expect(sim.actors.get("r2")!.tile).toEqual(tables[0]);
  });

  it("keeps a seated researcher's table when a colliding neighbour leaves", () => {
    const office = createOffice(officeLayout(1056, 624, 6));
    const tables = office.layout.researchTables;
    const sim = office.createSimulation();
    // Slots 0 and 2 both map to table 0, so slot 2 settles at table 1.
    const a: Lane = { ...worker, id: "a", slot: 0, role: "researcher" };
    const b: Lane = { ...worker, id: "b", slot: 2, role: "researcher" };
    for (let frame = 0; frame < 2400; frame += 1) office.updateActors(sim, [a, b], frame * 16);
    expect(sim.actors.get("a")!.tile).toEqual(tables[0]);
    expect(sim.actors.get("b")!.tile).toEqual(tables[1]);
    const aDone: Lane = { ...a, role: "terminal" };
    for (let frame = 0; frame < 2400; frame += 1) {
      office.updateActors(sim, [aDone, b], 40_000 + frame * 16);
    }
    expect(sim.actors.get("b")!.tile).toEqual(tables[1]);
    expect(sim.actors.get("b")!.seated).toBe(true);
  });
});

describe("rescues", () => {
  it("carries a failed agent out once and does not respawn it", () => {
    const office = createOffice(officeLayout(1056, 624, 6));
    const sim = office.createSimulation();
    for (let frame = 0; frame < 1800; frame += 1) office.updateActors(sim, [worker], frame * 16);
    const failed: Lane = { ...worker, status: "failed" };
    let spawns = 0;
    let lastActor = sim.actors.get(worker.id);
    for (let frame = 0; frame < 6000; frame += 1) {
      const now = 30_000 + frame * 16;
      office.updateActors(sim, [failed], now);
      office.rescueTick(sim, [failed], now);
      const actor = sim.actors.get(worker.id);
      if (actor && actor !== lastActor) spawns += 1;
      lastActor = actor;
    }
    expect(spawns).toBe(0);
    expect(sim.actors.has(worker.id)).toBe(false);
    expect(sim.rescues).toHaveLength(0);
    // Reactivating the agent brings it back through the door.
    office.updateActors(sim, [worker], 200_000);
    expect(sim.actors.has(worker.id)).toBe(true);
  });
});

describe("settling", () => {
  it("reports settled once everyone has arrived and unsettled while anyone moves", () => {
    const { lanes } = officeRoster(
      panelModel([
        subagent({ id: "a" }),
        subagent({ id: "b" }),
        subagent({ id: "c", status: "idle" }),
      ]),
    );
    const office = createOffice(officeLayout(1056, 624, lanes.length));
    const sim = office.createSimulation();
    office.updateActors(sim, lanes, 0);
    expect(office.isSettled(sim, lanes, 0)).toBe(false);
    let settledAt = -1;
    for (let frame = 1; frame < 4000 && settledAt < 0; frame += 1) {
      office.updateActors(sim, lanes, frame * 16);
      if (office.isSettled(sim, lanes, frame * 16)) settledAt = frame;
    }
    expect(settledAt).toBeGreaterThan(0);
    // Once settled, the working agents never move again and the room is quiet
    // apart from rare, bounded ambient events (a 2 s steam puff every ~9 s).
    const seated = lanes.filter((lane) => lane.status === "working");
    const snapshot = seated.map((lane) => String(sim.actors.get(lane.id)!.tile));
    let quietTicks = 0;
    const ticks = 600;
    for (let frame = 0; frame < ticks; frame += 1) {
      const now = 100_000 + frame * 16;
      office.updateActors(sim, lanes, now);
      if (office.isSettled(sim, lanes, now)) quietTicks += 1;
    }
    expect(seated.map((lane) => String(sim.actors.get(lane.id)!.tile))).toEqual(snapshot);
    expect(quietTicks / ticks).toBeGreaterThan(0.75);
    // The idle agent is in the break area.
    const idle = sim.actors.get("c")!;
    expect(office.layout.map[idle.tile[1]]![idle.tile[0]]).toBe(",");
    // A lane change unsettles the room until the walk finishes.
    const leaving = officeRoster(
      panelModel([
        subagent({ id: "a", status: "completed" }),
        subagent({ id: "b" }),
        subagent({ id: "c", status: "idle" }),
      ]),
    ).lanes;
    office.updateActors(sim, leaving, 200_000);
    expect(office.isSettled(sim, leaving, 200_000)).toBe(false);
    let t = 200_000;
    for (; t < 200_000 + 4000 * 16; t += 16) office.updateActors(sim, leaving, t);
    expect(sim.actors.has("a")).toBe(false);
    expect(sim.actors.get("b")!.moving).toBe(false);
  });

  it("schedules ambient events only while occupied, and each one is bounded", () => {
    const office = createOffice(officeLayout(1056, 624, 3));
    const sim = office.createSimulation();
    // Empty office: nothing to wake for.
    office.updateActors(sim, [], 0);
    expect(office.isSettled(sim, [], 0)).toBe(true);
    expect(office.nextWakeAt(sim, [], 0)).toBeNull();
    // One idle agent settles at a break spot; a wander is then due within 30 to 60 s.
    const idle: Lane = { ...worker, status: "idle" };
    let now = 0;
    for (; now < 6000 * 16 && !office.isSettled(sim, [idle], now); now += 16) {
      office.updateActors(sim, [idle], now);
    }
    expect(office.isSettled(sim, [idle], now)).toBe(true);
    const wanderAt = sim.ambient.nextWanderAt!;
    expect(wanderAt - now).toBeGreaterThanOrEqual(0);
    expect(wanderAt - now).toBeLessThanOrEqual(60_000);
    const next = office.nextWakeAt(sim, [idle], now)!;
    expect(next).toBeGreaterThan(now);
    expect(next).toBeLessThanOrEqual(wanderAt);
    // The wander is one bounded walk to a different break spot.
    const before = String(sim.actors.get(idle.id)!.tile);
    office.updateActors(sim, [idle], wanderAt);
    office.updateActors(sim, [idle], wanderAt + 16);
    expect(sim.actors.get(idle.id)!.moving).toBe(true);
    let t = wanderAt + 32;
    for (; t < wanderAt + 4000 * 16 && sim.actors.get(idle.id)!.moving; t += 16) {
      office.updateActors(sim, [idle], t);
    }
    expect(sim.actors.get(idle.id)!.moving).toBe(false);
    expect(String(sim.actors.get(idle.id)!.tile)).not.toBe(before);
    // Forty seconds after sitting back down a seated agent dozes; a standing one
    // does not, and the wake schedule reflects which it is.
    const actor = sim.actors.get(idle.id)!;
    const inSeat = office.layout.cafeSeats.some((seat) => String(seat.tile) === String(actor.tile));
    const dozeAt = actor.idleSince! + 40_000;
    if (inSeat) expect(office.nextWakeAt(sim, [idle], t)).toBeLessThanOrEqual(dozeAt);
    office.updateActors(sim, [idle], dozeAt + 16);
    expect(actor.sleeping).toBe(inSeat && !actor.moving);
  });

  it("shuffles papers for a bounded time after a researcher reports progress", () => {
    const office = createOffice(officeLayout(1056, 624, 6));
    const sim = office.createSimulation();
    const reader: Lane = { ...worker, role: "researcher", bubbleText: "reading the RFC" };
    let now = 16;
    for (; now < 6000 * 16 && !sim.actors.get(reader.id)?.seated; now += 16) {
      office.updateActors(sim, [reader], now);
    }
    const table = String(sim.actors.get(reader.id)!.tile);
    expect(office.layout.researchTables.map(String)).toContain(table);
    const shuffle = () => sim.shuffles.get(table);
    // Sitting down started one shuffle, which ends on its own.
    expect(shuffle()?.round).toBe(1);
    office.updateActors(sim, [reader], now + 3000);
    expect(office.isSettled(sim, [reader], now + 3000) || sim.ambient.steamStart !== null).toBe(
      true,
    );
    // New progress starts one more; the same progress again does not.
    const progressed: Lane = { ...reader, bubbleText: "comparing two approaches" };
    office.updateActors(sim, [progressed], now + 3016);
    expect(shuffle()?.round).toBe(2);
    expect(office.isSettled(sim, [progressed], now + 3016)).toBe(false);
    office.updateActors(sim, [progressed], now + 6000);
    expect(shuffle()?.round).toBe(2);
    office.updateActors(sim, [progressed], now + 12_000);
    expect(shuffle()?.round).toBe(2);
  });
});

describe("office selection", () => {
  it("hits the seated visual position without moving the navigation anchor", () => {
    const office = createOffice(officeLayout(1056, 624, 6));
    const sim = office.createSimulation();
    for (let frame = 0; frame < 1800; frame += 1) office.updateActors(sim, [worker], frame * 16);
    const actor = sim.actors.get(worker.id)!;
    expect(actor.seated).toBe(true);
    expect(actor.tile).toEqual(office.layout.desks[0]);
    expect(office.hitTest(sim, actor.x, actor.y - 18)).toBe(worker.id);
    expect(office.hitTest(sim, actor.x, actor.y + 2)).toBeNull();
    expect(office.hitTest(sim, actor.x + 20, actor.y - 18)).toBeNull();
    actor.exiting = true;
    expect(office.hitTest(sim, actor.x, actor.y - 18)).toBeNull();
  });

  it("preserves selection coordinates through resizing and never revives a departed agent", () => {
    const office = createOffice(officeLayout(1056, 624, 6));
    const sim = office.createSimulation();
    for (let frame = 0; frame < 1800; frame += 1) office.updateActors(sim, [worker], frame * 16);
    const resized = createOffice(officeLayout(390, 800, 6));
    resized.reflow(sim, [worker], office.width, office.height);
    const actor = sim.actors.get(worker.id)!;
    expect(resized.hitTest(sim, actor.x, actor.y - 18)).toBe(worker.id);
    const departed: Lane = { ...worker, status: "departing" };
    for (let frame = 0; frame < 1800; frame += 1) resized.updateActors(sim, [departed], frame * 16);
    expect(sim.actors.has(worker.id)).toBe(false);
    expect(sim.departed.has(worker.id)).toBe(true);
    office.reflow(sim, [departed], resized.width, resized.height);
    office.updateActors(sim, [departed], 30_000);
    expect(sim.actors.has(worker.id)).toBe(false);
    office.updateActors(sim, [worker], 30_016);
    expect(sim.actors.has(worker.id)).toBe(true);
  });
});

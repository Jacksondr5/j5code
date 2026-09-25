import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  drawEmployee,
  drawOfficePiece,
  type Look,
  type OfficeSheetAssets,
} from "./officeSheetAssets";
import type { officeLayout } from "./officeLayout";

type Dir = "up" | "down" | "left" | "right";
/** The agent's real lifecycle state, collapsed only where the office draws two states alike. */
type LaneStatus = "pending" | "working" | "waiting" | "idle" | "failed" | "departing";
type Tile = [number, number];

export interface Lane {
  id: string;
  label: string;
  role: string;
  slot: number;
  status: LaneStatus;
  /** Shirt colour; doubles as the lane's accent in the UI. */
  color: string;
  hair: string;
  pants: string;
  bubbleText: string | null;
}

interface Actor {
  x: number;
  y: number;
  tile: Tile;
  goal: Tile | null;
  path: Tile[];
  dir: Dir;
  frameT: number;
  moving: boolean;
  seated: boolean;
  gone: boolean;
  exiting: boolean;
  cafeSpot: Tile | null;
  rescueStarted: boolean;
  /** Simulation time the lane became idle; null while not idle. Drives dozing off. */
  idleSince: number | null;
  sleeping: boolean;
}

interface Rescue {
  id: string;
  lane: Lane;
  phase: "in" | "load" | "out" | "offscreen";
  t0: number;
  x: number;
  y: number;
  tile: Tile;
  path: Tile[];
  frameT: number;
  moving: boolean;
  done: boolean;
}

interface Simulation {
  actors: Map<string, Actor>;
  /** Lanes whose actor has left the building; kept until the agent genuinely reactivates. */
  departed: Set<string>;
  /** Research table index claimed per agent id, held until the agent stops researching. */
  researchClaims: Map<string, number>;
  /** Desk index owned per agent id for as long as the agent is on the roster. */
  deskClaims: Map<string, number>;
  rescues: Rescue[];
  /** Bounded paper shuffles per research table, keyed by seat tile. */
  shuffles: Map<string, { start: number; round: number }>;
  /** Last progress text seen per lane; a change while researching starts a shuffle. */
  progressSeen: Map<string, string | null>;
  /**
   * Ambient life as rare, bounded events. Each has a scheduled start; between
   * events the room is settled and the panel schedules no frames.
   */
  ambient: {
    /** Next time an idle agent takes a short walk to another break spot. */
    nextWanderAt: number | null;
    /** Next coffee-machine puff, and when the current one started. */
    nextSteamAt: number | null;
    steamStart: number | null;
  };
}

/** A furniture piece baked into the room cache, kept for occlusion repaints over actors. */
interface Piece {
  depth: number;
  left: number;
  top: number;
  width: number;
  height: number;
  paint: (context: CanvasRenderingContext2D) => void;
}

export interface RoomCache {
  canvas: HTMLCanvasElement;
  furniture: Piece[];
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/**
 * Purely decorative: picks which desk screen and seat an agent gets from words in
 * its role, title, or progress. Whole words only, so "npm" is not a PM.
 */
function roleForAgent(agent: RuntimeSubagent): string {
  const hint = `${agent.role ?? ""} ${agent.title} ${agent.progress ?? ""}`.toLowerCase();
  if (/\breview(er|ing|s)?\b/.test(hint)) return "reviewer";
  if (/\bsecur(e|ity)\b/.test(hint)) return "security";
  if (/\bresearch(er|ing)?\b/.test(hint)) return "researcher";
  if (/\b(jira|tickets?|pm)\b/.test(hint)) return "jira";
  return "terminal";
}

/** Maps the runtime status onto the office's states without inventing activity. */
function laneStatus(agent: RuntimeSubagent): LaneStatus {
  switch (agent.status) {
    case "pending":
      return "pending";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "idle":
      return "idle";
    case "completed":
    case "cancelled":
    case "interrupted":
      return "departing";
    default:
      return "working";
  }
}

/** Live agents come first so the desk cap drops finished ones before running ones. */
const STATUS_PRIORITY: Record<LaneStatus, number> = {
  working: 0,
  waiting: 1,
  pending: 2,
  idle: 3,
  failed: 4,
  departing: 5,
};

/** Desks the layout can hold; more agents than this fall off the canvas. */
const MAX_AGENT_LANES = 22;

export function officeRoster(model: AgentPanelModel): { lanes: Lane[]; omitted: number } {
  const agents = [
    ...model.workflows.flatMap((group) => {
      const members = workflowMembers(group);
      return members.length > 0 ? members : [group.workflow];
    }),
    ...model.directAgents,
  ];
  if (agents.length === 0) return { lanes: [], omitted: 0 };
  const ordered = agents
    .map((agent, index) => ({ agent, index, status: laneStatus(agent) }))
    .sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || a.index - b.index);
  // Priority decides who is admitted under the cap; slots follow the model's own
  // order so a status change never renumbers anyone.
  const shown = ordered.slice(0, MAX_AGENT_LANES).sort((a, b) => a.index - b.index);
  const agentLanes = shown.map(({ agent, status }, index) => ({
    id: agent.id,
    label: agent.title.replace(/^Subagent:\s*/i, ""),
    role: roleForAgent(agent),
    slot: index,
    status,
    color: pick(agent.id, SHIRTS),
    hair: pick(`${agent.id}:hair`, HAIR),
    pants: pick(`${agent.id}:pants`, PANTS),
    bubbleText:
      agent.status === "waiting"
        ? "waiting"
        : agent.status === "failed"
          ? "crashed"
          : agent.progress,
  }));
  return { lanes: agentLanes, omitted: agents.length - shown.length };
}

const SHIRTS = [
  "#14b8a6",
  "#60a5fa",
  "#f59e0b",
  "#ef4444",
  "#a78bfa",
  "#22c55e",
  "#f472b6",
  "#38bdf8",
  "#e11d48",
  "#84cc16",
  "#fb923c",
  "#c084fc",
  "#f5f5f4",
  "#1e293b",
  "#facc15",
  "#0ea5e9",
];
const HAIR = [
  "#1f1a17",
  "#3b2a1e",
  "#5a3a22",
  "#8a5a2b",
  "#c98a3c",
  "#e6c479",
  "#a8362b",
  "#d9613f",
  "#6b6b70",
  "#e5e1d6",
  "#3a4a8a",
  "#7a3a7a",
  "#2f7a6b",
];
const PANTS = [
  "#3d4668",
  "#2f2f35",
  "#6b5a45",
  "#4a6b8a",
  "#7a4a3a",
  "#556b4a",
  "#8a8a90",
  "#2c3e6b",
  "#a08a6a",
  "#4b2e4a",
];

function pick(seed: string, palette: readonly string[]): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length] ?? palette[0]!;
}

/** World units per 60Hz tick. Ten tiles take roughly a second and a half. */
const WALK_SPEED = 1.8;

export function createOffice(layout: ReturnType<typeof officeLayout>) {
  const T = 16;
  const MAP = layout.map;
  const MAP_H = layout.rows;
  const MAP_W = layout.columns;
  const WORLD_W = MAP_W * T;
  const WORLD_H = MAP_H * T;
  const WALKABLE = new Set([",", ".", "o", "d", "m"]);
  const ENTRY = layout.entry;
  const DESK_SPOTS = layout.desks;
  const CAFE_SEATS = layout.cafeSeats;
  const RESEARCH_TABLES = layout.researchTables;
  const sameTile = (a: readonly [number, number], b: readonly [number, number]) =>
    a[0] === b[0] && a[1] === b[1];
  const atResearchTable = (tile: readonly [number, number]) =>
    RESEARCH_TABLES.some((table) => sameTile(table, tile));
  /** Desk and research table sprites share one footprint anchored on the seat tile. */
  function stationBox(seat: readonly [number, number]) {
    const left = (seat[0] - 1) * T + 8;
    const top = (seat[1] - 1) * T - 8;
    return { left, top, width: 32, height: seat[1] * T + 14 - top };
  }
  function collectTiles(...matches: string[]): Tile[] {
    const wanted = new Set(matches);
    const tiles: Tile[] = [];
    for (let r = 1; r < MAP_H - 1; r += 1) {
      for (let c = 1; c < MAP_W - 1; c += 1) {
        if (wanted.has(MAP[r]?.[c] ?? "")) tiles.push([c, r]);
      }
    }
    return tiles;
  }

  const CAFE_TILES = collectTiles(",");
  function tileAt(c: number, r: number): string {
    return MAP[r]?.[c] ?? "#";
  }

  function tileCenter(tile: readonly [number, number]) {
    return { x: tile[0] * T + T / 2, y: tile[1] * T + T - 2 };
  }

  function bfs(from: readonly [number, number], to: readonly [number, number]) {
    if (from[0] === to[0] && from[1] === to[1]) return [];
    const key = (c: number, r: number) => r * MAP_W + c;
    const prev = new Map<number, number | null>([[key(from[0], from[1]), null]]);
    const q: Tile[] = [[from[0], from[1]]];
    for (let cursor = 0; cursor < q.length; cursor += 1) {
      const [c, r] = q[cursor]!;
      for (const [dc, dr] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ] as const) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= MAP_W || nr >= MAP_H) continue;
        const k = key(nc, nr);
        if (prev.has(k)) continue;
        const isDest = nc === to[0] && nr === to[1];
        if (!WALKABLE.has(tileAt(nc, nr)) && !isDest) continue;
        prev.set(k, key(c, r));
        if (isDest) {
          const path: Tile[] = [[nc, nr]];
          let cur = key(c, r);
          while (cur !== key(from[0], from[1])) {
            path.unshift([cur % MAP_W, Math.floor(cur / MAP_W)]);
            cur = prev.get(cur) ?? key(from[0], from[1]);
          }
          return path;
        }
        q.push([nc, nr]);
      }
    }
    return [];
  }

  function px(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
  ) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }

  /**
   * Paints everything static (floors, walls, windows, furniture) into a cache
   * context and returns the furniture list so actors can be occluded correctly.
   */
  function paintRoom(ctx: CanvasRenderingContext2D, assets: OfficeSheetAssets): Piece[] {
    ctx.imageSmoothingEnabled = false;
    px(ctx, 0, 0, WORLD_W, WORLD_H, "#bbc4c5");
    const carpetTiles = new Set<string>();
    for (const [dc, dr] of DESK_SPOTS) {
      for (let c = dc - 2; c <= dc + 2; c += 1)
        for (let r = dr - 2; r <= dr + 1; r += 1) carpetTiles.add(`${c},${r}`);
    }
    // Floors are continuous surfaces. Props keep their alpha and native aspect ratio.
    for (let r = 0; r < MAP_H; r += 1) {
      for (let c = 0; c < MAP_W; c += 1) {
        const ch = tileAt(c, r);
        const x = c * T;
        const y = r * T;
        const wood = ch === "," || ch === "T" || ch === "C";
        const carpet = ch === "o" || carpetTiles.has(`${c},${r}`);
        const meeting =
          layout.meeting &&
          c >= layout.meeting[0] - 1 &&
          c <= layout.meeting[0] + 4 &&
          r >= layout.meeting[1] - 1 &&
          r <= layout.meeting[1] + 1;
        px(
          ctx,
          x,
          y,
          T,
          T,
          wood ? "#b6a28c" : meeting ? "#9daea8" : carpet ? "#858e9d" : "#bbc4c5",
        );
        if (wood) {
          px(ctx, x, y + 7, T, 0.5, "#a08e7c");
          px(ctx, x + (r % 2 ? 5 : 12), y, 0.5, 7, "#a08e7c");
        } else if (carpet) {
          for (let i = 0; i < 5; i += 1)
            px(ctx, x + ((i * 7 + r * 3) % 16), y + ((i * 5 + c) % 16), 0.5, 0.5, "#969eaa");
        } else if (r % 2 === 0) px(ctx, x, y, T, 0.5, "#b4bfc0");
      }
    }
    for (let r = 0; r < MAP_H; r += 1) {
      for (let c = 0; c < MAP_W; c += 1) {
        const ch = tileAt(c, r);
        const x = c * T;
        const y = r * T;
        switch (ch) {
          case "#":
            if (c === layout.bossWall && r > 0 && r < 8) {
              px(ctx, x + 6, y, 4, T, "#7999a5");
              px(ctx, x + 7, y, 1, T, "#c5e0dc");
              px(ctx, x + 5, y, 1, T, "#46596b");
              if (r % 2 === 0) px(ctx, x + 5, y, 6, 1, "#46596b");
            } else if (r === 8 && c >= layout.bossWall && c < MAP_W - 1) {
              px(ctx, x, y + 6, T, 4, "#7999a5");
              px(ctx, x, y + 7, T, 1, "#c5e0dc");
              px(ctx, x, y + 10, T, 1, "#46596b");
            } else {
              px(ctx, x, y, T, T, "#535767");
              if (tileAt(c, r + 1) !== "#") {
                px(ctx, x, y + 10, T, 5, "#d9dedb");
                px(ctx, x, y + 15, T, 1, "#79838e");
              }
            }
            break;
          case "F":
            px(ctx, x, y, T, T, "#d9dedb");
            px(ctx, x, y + 14, T, 2, "#7d8693");
            break;
          case "W":
            px(ctx, x, y, T, T, "#d9dedb");
            px(ctx, x, y + 1, T, 13, "#535767");
            px(ctx, x + 1, y + 2, T - 2, 10, "#eff1e8");
            for (let i = 0; i < 3; i += 1)
              px(ctx, x + 3, y + 4 + i * 2, 7 + (i % 2) * 3, 0.5, i === 1 ? "#9d7278" : "#568b8b");
            break;
          case "m":
          case "d":
            px(ctx, x, y + 2, T, 12, "#687480");
            px(ctx, x, y + 4, T, 1, "#88949d");
            break;
        }
      }
    }
    // Windows and the wall clock are drawn live: they follow the time of day and
    // change at most once a minute.

    const furniture: Piece[] = [];
    const add = (
      depth: number,
      bounds: readonly [left: number, top: number, width: number, height: number],
      paint: (context: CanvasRenderingContext2D) => void,
    ) =>
      furniture.push({
        depth,
        left: bounds[0],
        top: bounds[1],
        width: bounds[2],
        height: bounds[3],
        paint,
      });
    for (let r = 0; r < MAP_H; r += 1) {
      for (let c = 0; c < MAP_W; c += 1) {
        const ch = tileAt(c, r);
        const x = c * T;
        const y = r * T;
        if ((ch === "D" || ch === "B") && tileAt(c - 1, r) !== ch) {
          add(y + 15, [x + 8, y - 8, 32, 32], (context) => {
            drawOfficePiece(context, assets, "desk", x + 8, y - 8);
            drawOfficePiece(context, assets, "laptop", x + 16, y - 4);
            px(context, x + 11, y + 7, 3, 3, "#e2ded1");
          });
        } else if (ch === "P") {
          add(y + T, [x, y - T * 2, 16, 48], (context) =>
            drawOfficePiece(context, assets, "planter", x, y - T * 2),
          );
        } else if (ch === "X") {
          add(y + T, [x - 4, y - T, 32, 32], (context) =>
            drawOfficePiece(context, assets, "copier", x - 4, y - T),
          );
        } else if (ch === "C") {
          add(y + T, [x, y - 8, 16, 24], (context) => {
            px(context, x + 1, y, 14, T, "#575768");
            px(context, x + 2, y, 12, 5, "#dbddd3");
            px(context, x + 3, y + 6, 10, 8, "#adb5b7");
            px(context, x + 9, y + 7, 2, 1, "#575768");
            if (r === layout.cafeTop) drawOfficePiece(context, assets, "coffee", x, y - 8);
          });
        } else if (ch === "R" && tileAt(c - 1, r) !== ch) {
          // Reading table on the desk footprint: a deeper wood top, turned legs,
          // a stack of books and a mug. Papers are drawn live so they can move.
          const x0 = x + 8;
          const y0 = y - 4;
          add(y + 15, [x0, y0, 32, 19], (context) => {
            px(context, x0 + 2, y0 + 12, 2, 7, "#3b2f26");
            px(context, x0 + 28, y0 + 12, 2, 7, "#3b2f26");
            px(context, x0 + 1, y0 + 10, 30, 3, "#5a4534");
            px(context, x0, y0, 32, 10, "#8d6b4b");
            px(context, x0 + 1, y0 + 1, 30, 1, "#a98561");
            px(context, x0, y0 + 9, 32, 1, "#6f5339");
            px(context, x0 + 24, y0 + 1, 7, 2, "#b5483f");
            px(context, x0 + 25, y0 + 3, 6, 2, "#3f6fb5");
            px(context, x0 + 24, y0 + 5, 7, 2, "#4c9a5c");
            px(context, x0 + 2, y0 + 3, 4, 4, "#e8e4da");
            px(context, x0 + 6, y0 + 4, 1, 2, "#e8e4da");
          });
        } else if ((ch === "T" || ch === "M") && tileAt(c - 1, r) !== ch) {
          const width = ch === "M" ? 62 : 30;
          add(y + 14, [x, y - 7, width + 2, 21], (context) => {
            px(context, x + 2, y + 3, width - 2, 11, "#53505f");
            px(context, x + 1, y, width, 10, "#d1c2aa");
            px(context, x + 3, y + 1, width - 4, 1, "#e4d9c6");
            px(context, x + 8, y + 3, 3, 3, "#f1efe4");
            if (ch === "M") {
              drawOfficePiece(context, assets, "laptop", x + 22, y - 7);
              px(context, x + 45, y + 3, 7, 4, "#edf0e8");
            }
          });
        }
      }
    }
    const meeting = layout.meeting;
    const chairs: Array<{ tile: readonly [number, number]; dir: "up" | "down" }> = [
      ...DESK_SPOTS.map((tile) => ({ tile, dir: "up" as const })),
      { tile: layout.boss, dir: "up" },
      ...RESEARCH_TABLES.map((tile) => ({ tile, dir: "up" as const })),
      ...CAFE_SEATS,
      ...(meeting
        ? [0, 3].flatMap((offset) => [
            { tile: [meeting[0] + offset, meeting[1] - 1] as const, dir: "down" as const },
            { tile: [meeting[0] + offset, meeting[1] + 1] as const, dir: "up" as const },
          ])
        : []),
    ];
    for (const { tile, dir } of chairs) {
      const [c, r] = tile;
      add(r * T - 8, [c * T, r * T - 12, 16, 18], (context) => {
        drawOfficePiece(context, assets, dir === "up" ? "chairBack" : "chair", c * T, r * T - 12);
      });
      if (dir === "up")
        add(r * T + 15, [c * T, r * T - 2, 16, 8], (context) => {
          context.save();
          context.beginPath();
          context.rect(c * T, r * T - 2, T, 8);
          context.clip();
          drawOfficePiece(context, assets, "chairBack", c * T, r * T - 12);
          context.restore();
        });
    }
    furniture.sort((a, b) => a.depth - b.depth);
    for (const piece of furniture) piece.paint(ctx);
    return furniture;
  }

  function actorPosition(actor: Actor) {
    return { x: actor.x, y: actor.y - (actor.seated ? 6 : 0) };
  }

  function hitTest(sim: Simulation, x: number, y: number) {
    let hit: string | null = null;
    let depth = -Infinity;
    for (const [id, actor] of sim.actors) {
      if (actor.gone || actor.exiting || actor.rescueStarted) continue;
      const point = actorPosition(actor);
      if (Math.abs(x - point.x) <= 9 && y >= point.y - 25 && y <= point.y + 3 && point.y >= depth) {
        hit = id;
        depth = point.y;
      }
    }
    return hit;
  }

  const DIRECTION_ROW = { up: 0, left: 1, down: 2, right: 3 } as const;

  function drawShadow(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.fillStyle = "rgba(39,38,52,0.18)";
    ctx.beginPath();
    ctx.ellipse(x, y - 1, 4.5, 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSprite(
    ctx: CanvasRenderingContext2D,
    actor: Actor,
    look: Look,
    assets: OfficeSheetAssets,
  ) {
    const frame = actor.moving ? Math.floor(actor.frameT / 4) % 8 : 2;
    drawShadow(ctx, actor.x, actor.y);
    drawEmployee(
      ctx,
      assets,
      DIRECTION_ROW[actor.dir],
      frame,
      actor.x,
      actor.y,
      actor.moving ? "walk" : actor.seated ? "sitting" : "idle",
      look,
    );
    if (actor.sleeping) {
      // Still marks, no float: dozing is a state, not an animation.
      ctx.fillStyle = "#e8ecf2";
      ctx.strokeStyle = "#2b2633";
      ctx.textAlign = "left";
      for (let i = 0; i < 3; i += 1) {
        ctx.font = `bold ${4 + i * 2}px system-ui, sans-serif`;
        ctx.strokeText("z", actor.x + 6 + i * 4, actor.y - 20 - i * 3);
        ctx.fillText("z", actor.x + 6 + i * 4, actor.y - 20 - i * 3);
      }
    }
  }

  function drawBubble(
    ctx: CanvasRenderingContext2D,
    actor: { x: number; y: number },
    text: string,
  ) {
    const t = text.length > 18 ? `${text.slice(0, 17)}...` : text;
    ctx.font = "7px system-ui, sans-serif";
    const w = Math.max(14, ctx.measureText(t).width + 8);
    const x = Math.round(Math.min(Math.max(actor.x - w / 2, 2), WORLD_W - w - 2));
    const y = Math.round(actor.y - 34);
    px(ctx, x, y, w, 11, "#f8f8f0");
    ctx.strokeStyle = "#3a3a3a";
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 10);
    px(ctx, Math.round(actor.x) - 1, y + 11, 3, 3, "#f8f8f0");
    ctx.fillStyle = "#26262e";
    ctx.textAlign = "left";
    ctx.fillText(t, x + 4, y + 8);
  }

  function screenHash(n: number) {
    let h = n ^ 61 ^ (n >>> 16);
    h = (h + (h << 3)) | 0;
    h ^= h >>> 4;
    h = (h * 0x27d4eb2d) | 0;
    return (h ^ (h >>> 15)) >>> 0;
  }

  const screenBuf = typeof document === "undefined" ? null : document.createElement("canvas");
  if (screenBuf) {
    screenBuf.width = 16;
    screenBuf.height = 12;
  }

  /** A still screen per role; nothing here depends on time, so a seated agent's frame is stable. */
  function drawRoleScreen(ctx: CanvasRenderingContext2D, lane: Lane, seed: number) {
    if (lane.role === "reviewer") {
      px(ctx, 0, 0, 16, 12, "#e6e9ef");
      px(ctx, 3, 2, 10, 7, "#24292f");
      px(ctx, 5, 4, 6, 3, "#f6f8fa");
      px(ctx, 2, 10, 5, 1, "#2ea043");
      px(ctx, 9, 10, 5, 1, "#d1242f");
    } else if (lane.role === "security") {
      px(ctx, 0, 0, 16, 12, "#eef1f5");
      px(ctx, 4, 1, 8, 5, "#2f7dd1");
      px(ctx, 5, 6, 6, 2, "#2f7dd1");
      px(ctx, 6, 8, 4, 1, "#2f7dd1");
      px(ctx, 7, 2, 2, 4, "#2fbf71");
    } else if (lane.role === "researcher") {
      px(ctx, 0, 0, 16, 12, "#edeff3");
      px(ctx, 2, 1, 5, 5, "#4a5160");
      px(ctx, 3, 2, 3, 3, "#cfe3f2");
      px(ctx, 7, 6, 3, 1, "#4a5160");
      for (let i = 0; i < 3; i += 1)
        px(ctx, 2, 9 + i, i === 2 ? 8 : 12, 1, i === 0 ? "#5d6575" : "#aab1bd");
    } else if (lane.role === "jira") {
      px(ctx, 0, 0, 16, 12, "#e9eef7");
      for (let d = -3; d <= 3; d += 1)
        px(ctx, 6 - (3 - Math.abs(d)), 5 + d, (3 - Math.abs(d)) * 2 + 1, 1, "#2684ff");
      for (let d = -2; d <= 2; d += 1)
        px(ctx, 10 - (2 - Math.abs(d)), 3 + d, (2 - Math.abs(d)) * 2 + 1, 1, "#a9ccff");
      px(ctx, 4, 9, 8, 1, "#c3d4ef");
    } else {
      px(ctx, 0, 0, 16, 12, "#0a140e");
      for (let i = 0; i < 9; i += 1) {
        const h = screenHash(seed + i);
        const w = 3 + (h % 10);
        const indent = 1 + ((h >>> 3) % 3);
        px(ctx, indent, 1 + i, Math.min(w, 14 - indent), 1, i >= 6 ? "#49f087" : "#2fae63");
      }
      px(ctx, 4, 10, 2, 1, "#7dffab");
    }
    if (lane.status === "waiting") {
      px(ctx, 11, 0, 4, 4, "rgba(10,12,18,0.85)");
      px(ctx, 13, 2, 1, 1, "#ffd257");
    }
  }

  /** Paints each occupied desk's laptop screen with that agent's role picture. */
  function drawDeskScreens(
    ctx: CanvasRenderingContext2D,
    lanes: ReadonlyArray<Lane>,
    sim: Simulation,
  ) {
    const screenCtx = screenBuf?.getContext("2d");
    if (!screenCtx || !screenBuf) return;
    const seated = new Map<string, Lane>();
    for (const lane of lanes) {
      const actor = sim.actors.get(lane.id);
      if (actor?.seated && !actor.gone) seated.set(`${actor.tile[0]},${actor.tile[1]}`, lane);
    }
    for (const [c, r] of DESK_SPOTS) {
      const lane = seated.get(`${c},${r}`);
      if (!lane || lane.status !== "working") continue;
      drawRoleScreen(screenCtx, lane, c * 31 + r * 7);
      ctx.drawImage(screenBuf, c * T + 4, (r - 1) * T, 8, 5);
    }
  }

  const PAPER_MOVE_MS = 700;
  const PAPERS_PER_TABLE = 4;
  /** One shuffle moves every paper once, then the table is still again. */
  const SHUFFLE_MS = PAPER_MOVE_MS * PAPERS_PER_TABLE;
  const tileKey = (tile: readonly [number, number]) => `${tile[0]},${tile[1]}`;

  function shuffleActive(sim: Simulation, seat: readonly [number, number], now: number) {
    const shuffle = sim.shuffles.get(tileKey(seat));
    return shuffle !== undefined && now - shuffle.start < SHUFFLE_MS;
  }

  /** Starts a shuffle at a table unless one is already running. */
  function startShuffle(sim: Simulation, seat: readonly [number, number], now: number) {
    const key = tileKey(seat);
    const current = sim.shuffles.get(key);
    if (current && now - current.start < SHUFFLE_MS) return;
    sim.shuffles.set(key, { start: now, round: (current?.round ?? 0) + 1 });
  }

  /**
   * Papers on each research table. They lie still until a shuffle starts (the
   * seated researcher reported new progress); then one paper at a time is lifted,
   * carried in an arc, and set down in a new spot, and the table is still again.
   */
  function drawResearchPapers(ctx: CanvasRenderingContext2D, sim: Simulation, now: number) {
    RESEARCH_TABLES.forEach((seat, tableIndex) => {
      const shuffle = sim.shuffles.get(tileKey(seat));
      const round = shuffle?.round ?? 0;
      const elapsedMs = shuffle ? now - shuffle.start : Number.POSITIVE_INFINITY;
      const box = stationBox(seat);
      const spot = (paper: number, move: number) => {
        const h = screenHash(tableIndex * 97 + paper * 13 + move * 7);
        return { x: box.left + 2 + (h % 15), y: box.top + 5 + ((h >>> 5) % 4) };
      };
      const papers: Array<{ x: number; y: number; lift: number }> = [];
      for (let i = 0; i < PAPERS_PER_TABLE; i += 1) {
        const turn = Math.floor(elapsedMs / PAPER_MOVE_MS);
        if (elapsedMs >= SHUFFLE_MS || turn > i) {
          papers.push({ ...spot(i, round), lift: 0 });
        } else if (turn === i) {
          const phase = (elapsedMs % PAPER_MOVE_MS) / PAPER_MOVE_MS;
          const from = spot(i, round - 1);
          const to = spot(i, round);
          const eased = phase < 0.5 ? 2 * phase * phase : 1 - (2 * (1 - phase)) ** 2 / 2;
          papers.push({
            x: from.x + (to.x - from.x) * eased,
            y: from.y + (to.y - from.y) * eased,
            lift: Math.sin(Math.PI * phase) * 4,
          });
        } else papers.push({ ...spot(i, round - 1), lift: 0 });
      }
      // Resting papers first, then the one in hand so it reads as on top.
      papers.sort((a, b) => a.lift - b.lift);
      for (const paper of papers) {
        const x = Math.round(paper.x);
        const y = Math.round(paper.y - paper.lift);
        if (paper.lift > 0.5) {
          px(ctx, x + 1, y + paper.lift + 1, 6, 7, `rgba(40, 32, 24, ${0.1 + paper.lift * 0.05})`);
        }
        px(ctx, x, y, 6, 7, paper.lift > 0.5 ? "#fbf9f2" : "#ece7da");
        px(ctx, x + 1, y + 1, 4, 1, "#a9a396");
        px(ctx, x + 1, y + 3, 3, 1, "#a9a396");
        px(ctx, x + 1, y + 5, 4, 1, "#a9a396");
      }
    });
  }

  function getActor(sim: Simulation, lane: Lane): Actor {
    let actor = sim.actors.get(lane.id);
    if (!actor) {
      const p = tileCenter(ENTRY);
      actor = {
        x: p.x,
        y: MAP_H * T + 20,
        tile: [ENTRY[0], ENTRY[1]],
        goal: null,
        path: [],
        dir: "down",
        frameT: 0,
        moving: false,
        seated: false,
        gone: false,
        exiting: false,
        cafeSpot: null,
        rescueStarted: false,
        idleSince: null,
        sleeping: false,
      };
      sim.actors.set(lane.id, actor);
    }
    return actor;
  }

  function zoneTarget(
    lane: Lane,
    actor: Actor,
    lanes: ReadonlyArray<Lane>,
    sim: Simulation,
  ): readonly [number, number] {
    if (lane.status === "departing") return ENTRY;
    const table = researchTableFor(lane, sim);
    if (table) return table;
    if (lane.status !== "idle") return deskFor(lane, sim);
    // Idle: take a break seat once and stay put; no wandering, so the room settles.
    if (!actor.cafeSpot) {
      const claimed = new Set<string>();
      for (const other of lanes) {
        const oa = sim.actors.get(other.id);
        if (!oa || oa === actor || oa.gone) continue;
        if (oa.cafeSpot) claimed.add(tileKey(oa.cafeSpot));
        claimed.add(tileKey(oa.tile));
      }
      const freeSeats = CAFE_SEATS.filter((seat) => !claimed.has(tileKey(seat.tile)));
      const freeTiles = CAFE_TILES.filter((tile) => !claimed.has(tileKey(tile)));
      const pick =
        freeSeats[lane.slot % Math.max(1, freeSeats.length)]?.tile ??
        freeTiles[lane.slot % Math.max(1, freeTiles.length)] ??
        CAFE_TILES[0] ??
        ENTRY;
      actor.cafeSpot = [pick[0], pick[1]];
    }
    return actor.cafeSpot;
  }

  const isResearching = (lane: Lane) => lane.status === "working" && lane.role === "researcher";

  /**
   * Seat ownership held by agent id so nobody moves when neighbours come or go.
   * A new claim starts at the seat matching the slot and takes the next free one.
   */
  function claimSeat(claims: Map<string, number>, lane: Lane, count: number): number | null {
    const held = claims.get(lane.id);
    if (held !== undefined && held < count) return held;
    const taken = new Set(claims.values());
    for (let tries = 0; tries < count; tries += 1) {
      const index = (lane.slot + tries) % count;
      if (taken.has(index)) continue;
      claims.set(lane.id, index);
      return index;
    }
    return null;
  }

  /** Releases claims whose agent left the roster or stopped researching. Runs once per tick. */
  function pruneClaims(sim: Simulation, lanes: ReadonlyArray<Lane>) {
    const present = new Set(lanes.map((lane) => lane.id));
    for (const id of sim.deskClaims.keys()) if (!present.has(id)) sim.deskClaims.delete(id);
    const researching = new Set(lanes.filter(isResearching).map((lane) => lane.id));
    for (const id of sim.researchClaims.keys()) {
      if (!researching.has(id)) sim.researchClaims.delete(id);
    }
  }

  /** The agent's own desk, claimed on first need and kept while it is on the roster. */
  function deskFor(lane: Lane, sim: Simulation): readonly [number, number] {
    const index = claimSeat(sim.deskClaims, lane, DESK_SPOTS.length);
    return DESK_SPOTS[index ?? lane.slot % DESK_SPOTS.length] ?? DESK_SPOTS[0]!;
  }

  /** A working researcher's table, or null when it is not researching or every table is claimed. */
  function researchTableFor(lane: Lane, sim: Simulation) {
    if (!isResearching(lane) || RESEARCH_TABLES.length === 0) return null;
    const index = claimSeat(sim.researchClaims, lane, RESEARCH_TABLES.length);
    return index === null ? null : (RESEARCH_TABLES[index] ?? null);
  }

  /** One waypoint step shared by agents and medics; returns the facing for the step. */
  function stepAlongPath(mover: {
    x: number;
    y: number;
    tile: Tile;
    path: Tile[];
    frameT: number;
  }): Dir {
    const next = tileCenter(mover.path[0]!);
    const dx = next.x - mover.x;
    const dy = next.y - mover.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= WALK_SPEED) {
      mover.x = next.x;
      mover.y = next.y;
      mover.tile = mover.path.shift()!;
    } else {
      mover.x += (dx / dist) * WALK_SPEED;
      mover.y += (dy / dist) * WALK_SPEED;
    }
    mover.frameT += 1;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  }

  /** Lanes whose actor was walked or carried out stay gone until the agent is live again. */
  const hasLeft = (lane: Lane) => lane.status === "departing" || lane.status === "failed";

  function updateActors(sim: Simulation, lanes: ReadonlyArray<Lane>, now: number) {
    const departed = sim.departed;
    pruneClaims(sim, lanes);
    for (const lane of lanes) {
      if (!hasLeft(lane)) departed.delete(lane.id);
      if (hasLeft(lane) && departed.has(lane.id)) continue;

      const actor = getActor(sim, lane);
      if (actor.gone || actor.rescueStarted) continue;
      if (lane.status !== "idle") {
        actor.cafeSpot = null;
        actor.idleSince = null;
        actor.sleeping = false;
      } else actor.idleSince ??= now;
      if (actor.exiting) {
        actor.dir = "down";
        actor.moving = true;
        actor.frameT += 1;
        actor.y += WALK_SPEED;
        if (actor.y > MAP_H * T + 8) {
          actor.gone = true;
          if (lane.status === "departing") departed.add(lane.id);
        }
        continue;
      }
      const goal = zoneTarget(lane, actor, lanes, sim);
      if (!actor.goal || actor.goal[0] !== goal[0] || actor.goal[1] !== goal[1]) {
        actor.goal = [goal[0], goal[1]];
        actor.path = bfs(actor.tile, goal);
      }
      if (actor.path.length) {
        actor.moving = true;
        actor.seated = false;
        actor.sleeping = false;
        actor.dir = stepAlongPath(actor);
      } else if (
        lane.status === "departing" &&
        actor.tile[0] === ENTRY[0] &&
        actor.tile[1] === ENTRY[1]
      ) {
        actor.exiting = true;
      } else {
        actor.moving = false;
        actor.frameT = 0;
        const onDesk = DESK_SPOTS.some(([c, r]) => c === actor.tile[0] && r === actor.tile[1]);
        const seat = CAFE_SEATS.find(
          (s) => s.tile[0] === actor.tile[0] && s.tile[1] === actor.tile[1],
        );
        const onResearch = atResearchTable(actor.tile);
        const justSat = !actor.seated && (onDesk || Boolean(seat) || onResearch);
        actor.seated = onDesk || Boolean(seat) || onResearch;
        actor.sleeping =
          Boolean(seat) && actor.idleSince !== null && now - actor.idleSince >= SLEEP_AFTER_MS;
        if (onDesk || onResearch) actor.dir = "up";
        else if (seat) actor.dir = seat.dir;
        else if (lane.status !== "idle") actor.dir = "up";
        // A seated researcher shuffles when it sits down and whenever its
        // progress changes: bounded motion tied to a real event.
        if (onResearch) {
          const seen = sim.progressSeen.get(lane.id);
          if (justSat || seen !== lane.bubbleText) startShuffle(sim, actor.tile, now);
        }
      }
      sim.progressSeen.set(lane.id, lane.bubbleText);
    }
    for (const [id, actor] of sim.actors) {
      const lane = lanes.find((candidate) => candidate.id === id);
      if (actor.gone && lane && hasLeft(lane)) departed.add(id);
      if (!lane || actor.gone) sim.actors.delete(id);
    }
    // Departure records matter only while the lane is still on the roster.
    for (const id of departed) if (!lanes.some((lane) => lane.id === id)) departed.delete(id);
    for (const id of sim.progressSeen.keys()) {
      if (!lanes.some((lane) => lane.id === id)) sim.progressSeen.delete(id);
    }
    tickAmbient(sim, lanes, now);
  }

  /** How long an agent idles in the break area before dozing off. */
  const SLEEP_AFTER_MS = 40_000;
  const WANDER_MIN_MS = 30_000;
  const WANDER_SPREAD_MS = 30_000;
  const STEAM_EVERY_MS = 9_000;
  const STEAM_MS = 2_000;

  /** Deterministic spread so tests can reason about cadence without Math.random. */
  const jitter = (seed: number, spread: number) => screenHash(Math.floor(seed)) % spread;

  /**
   * Schedules and fires the ambient events. Wandering sends one idle agent on a
   * bounded walk to a different break spot. Steam is a short puff at the coffee
   * machine. Both exist only while the office is occupied.
   */
  function tickAmbient(sim: Simulation, lanes: ReadonlyArray<Lane>, now: number) {
    const ambient = sim.ambient;
    const idlers = lanes.filter((lane) => {
      const actor = sim.actors.get(lane.id);
      return lane.status === "idle" && actor?.cafeSpot && !actor.moving;
    });
    if (idlers.length === 0) ambient.nextWanderAt = null;
    else {
      ambient.nextWanderAt ??= now + WANDER_MIN_MS + jitter(now, WANDER_SPREAD_MS);
      if (now >= ambient.nextWanderAt) {
        const lane = idlers[jitter(now + 7, idlers.length)]!;
        const actor = sim.actors.get(lane.id)!;
        const claimed = new Set<string>();
        for (const other of sim.actors.values()) {
          if (other === actor || other.gone) continue;
          if (other.cafeSpot) claimed.add(tileKey(other.cafeSpot));
          claimed.add(tileKey(other.tile));
        }
        const here = actor.cafeSpot ? tileKey(actor.cafeSpot) : "";
        const options = [...CAFE_SEATS.map((seat) => seat.tile), ...CAFE_TILES].filter(
          (tile) => !claimed.has(tileKey(tile)) && tileKey(tile) !== here,
        );
        const next = options[jitter(now + 13, Math.max(1, options.length))];
        if (next) {
          actor.cafeSpot = [next[0], next[1]];
          // Up and about again: the doze clock restarts when they sit back down.
          actor.idleSince = now;
        }
        ambient.nextWanderAt = now + WANDER_MIN_MS + jitter(now + 29, WANDER_SPREAD_MS);
      }
    }
    if (lanes.length === 0) {
      ambient.nextSteamAt = null;
      ambient.steamStart = null;
    } else {
      ambient.nextSteamAt ??= now + STEAM_EVERY_MS;
      if (ambient.steamStart !== null && now - ambient.steamStart >= STEAM_MS) {
        ambient.steamStart = null;
      }
      if (ambient.steamStart === null && now >= ambient.nextSteamAt) {
        ambient.steamStart = now;
        ambient.nextSteamAt = now + STEAM_EVERY_MS + jitter(now + 3, 4000);
      }
    }
  }

  /**
   * When the room is settled, the time of the next thing that will change it:
   * an ambient event, an idler dozing off, or the wall clock's next minute.
   * Null when nothing is scheduled (an empty office).
   */
  function nextWakeAt(sim: Simulation, lanes: ReadonlyArray<Lane>, now: number): number | null {
    const candidates: number[] = [];
    if (sim.ambient.nextWanderAt !== null) candidates.push(sim.ambient.nextWanderAt);
    if (sim.ambient.nextSteamAt !== null) candidates.push(sim.ambient.nextSteamAt);
    for (const lane of lanes) {
      const actor = sim.actors.get(lane.id);
      if (!actor || actor.idleSince === null || actor.sleeping) continue;
      // Only a seated idler dozes; a standing one has nothing scheduled.
      if (CAFE_SEATS.some((seat) => sameTile(seat.tile, actor.tile))) {
        candidates.push(actor.idleSince + SLEEP_AFTER_MS);
      }
    }
    if (lanes.length > 0) candidates.push(now + (60_000 - (Date.now() % 60_000)));
    if (candidates.length === 0) return null;
    return Math.max(now + 16, Math.min(...candidates));
  }

  /**
   * True when nothing is in transition: every actor has arrived, no rescue is
   * under way, and no paper shuffle is running. The panel stops scheduling
   * frames while this holds and wakes on lane, pointer, size, or asset events.
   */
  function isSettled(sim: Simulation, lanes: ReadonlyArray<Lane>, now: number) {
    for (const lane of lanes) {
      if (hasLeft(lane) && sim.departed.has(lane.id)) continue;
      const actor = sim.actors.get(lane.id);
      if (!actor) return false;
      if (actor.moving || actor.exiting || actor.path.length > 0 || actor.rescueStarted)
        return false;
      if (!actor.goal) return false;
    }
    if (sim.rescues.length > 0) return false;
    for (const table of RESEARCH_TABLES) if (shuffleActive(sim, table, now)) return false;
    if (sim.ambient.steamStart !== null && now - sim.ambient.steamStart < STEAM_MS) return false;
    return true;
  }

  /** 0 at night, 1 in daylight, ramping over dawn and dusk. */
  function daylight(): number {
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    const rise = Math.min(1, Math.max(0, (h - 6) / 1.5));
    const set = Math.min(1, Math.max(0, (19.5 - h) / 1.5));
    return Math.min(rise, set);
  }

  function drawWindows(ctx: CanvasRenderingContext2D, day: number) {
    for (const wc of layout.windows) {
      const x = wc * T;
      const y = T;
      const width = wc === layout.windows[0] ? Math.min(46, (layout.bossWall - wc) * T - 8) : 14;
      px(ctx, x + 1, y + 1, width, 11, "#46596b");
      px(
        ctx,
        x + 2,
        y + 2,
        width - 2,
        9,
        day > 0.6 ? "#9fc6e8" : day > 0.15 ? "#e0b58e" : "#18233f",
      );
      for (let offset = 14; offset < width - 2; offset += 15)
        px(ctx, x + offset, y + 2, 1, 9, "#46596b");
      px(ctx, x, y + 12, width + 2, 2, "#edf0e8");
      if (day < 0.15) {
        px(ctx, x + 4, y + 3, 2, 2, "#e8ecf2");
        px(ctx, x + 11, y + 4, 1, 1, "#c9d4ea");
      } else if (day > 0.6) px(ctx, x + 11, y + 3, 2, 2, "#fff3c4");
    }
  }

  function drawWallClock(ctx: CanvasRenderingContext2D) {
    const cx = layout.clock[0] * T + 8;
    const cy = layout.clock[1] * T + 7;
    ctx.fillStyle = "#2b2633";
    ctx.beginPath();
    ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f4f1e8";
    ctx.beginPath();
    ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
    ctx.fill();
    const d = new Date();
    const mA = (d.getMinutes() / 60) * Math.PI * 2 - Math.PI / 2;
    const hA = (((d.getHours() % 12) + d.getMinutes() / 60) / 12) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = "#2b2633";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(hA) * 2.8, cy + Math.sin(hA) * 2.8);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(mA) * 4.4, cy + Math.sin(mA) * 4.4);
    ctx.stroke();
  }

  function drawSteam(ctx: CanvasRenderingContext2D, sim: Simulation, now: number) {
    const start = sim.ambient.steamStart;
    if (start === null) return;
    const t = Math.min(1, (now - start) / STEAM_MS);
    for (let i = 0; i < 3; i += 1) {
      const p = (t + i * 0.33) % 1;
      const sway = Math.sin((p * 3 + i) * Math.PI * 2) * 1.5;
      px(
        ctx,
        T + 4 + i * 2 + sway,
        layout.cafeTop * T + 1 - 3 - p * 9,
        2,
        2,
        `rgba(232, 237, 242, ${0.65 * (1 - p)})`,
      );
    }
  }

  function drawDeskLamps(ctx: CanvasRenderingContext2D) {
    for (const [c, r] of DESK_SPOTS) {
      const x = c * T;
      const y = (r - 1) * T;
      px(ctx, x + 1, y + 2, 1, 4, "#6f5a3a");
      px(ctx, x, y + 1, 3, 2, "#3a3f4a");
      px(ctx, x + 1, y + 3, 1, 1, "#ffd98a");
      const g = ctx.createRadialGradient(x + 2, y + 4, 1, x + 2, y + 4, 13);
      g.addColorStop(0, "rgba(255, 200, 120, 0.28)");
      g.addColorStop(1, "rgba(255, 200, 120, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - 11, y - 9, 27, 27);
    }
  }

  function makeRescue(id: string, lane: Lane, victim: Actor, now: number): Rescue {
    const entry = tileCenter(ENTRY);
    return {
      id,
      lane,
      phase: "in",
      t0: now,
      x: entry.x,
      y: MAP_H * T + 26,
      tile: [ENTRY[0], ENTRY[1]],
      path: bfs(ENTRY, victim.tile),
      frameT: 0,
      moving: true,
      done: false,
    };
  }

  function rescueTick(sim: Simulation, lanes: ReadonlyArray<Lane>, now: number) {
    for (const lane of lanes) {
      if (lane.status !== "failed" || sim.departed.has(lane.id)) continue;
      const actor = getActor(sim, lane);
      if (!actor.gone && !actor.rescueStarted) {
        actor.rescueStarted = true;
        actor.moving = false;
        actor.seated = false;
        sim.rescues.push(makeRescue(lane.id, lane, actor, now));
      }
    }
    for (const resc of sim.rescues) {
      const victim = sim.actors.get(resc.id);
      if (!victim) {
        resc.done = true;
        continue;
      }
      if (resc.phase === "in" || resc.phase === "out") {
        if (resc.path.length) {
          stepAlongPath(resc);
          if (resc.phase === "out") {
            victim.x = resc.x;
            victim.y = resc.y - 7 + (Math.floor(now / 240) % 2);
          }
        } else if (resc.phase === "in") {
          resc.phase = "load";
          resc.t0 = now;
          resc.moving = false;
        } else {
          resc.phase = "offscreen";
        }
      } else if (resc.phase === "load") {
        if (now - resc.t0 > 1100) {
          resc.phase = "out";
          resc.path = bfs(resc.tile, ENTRY);
          resc.moving = true;
        }
      } else {
        resc.y += WALK_SPEED;
        victim.x = resc.x;
        victim.y = resc.y - 7;
        if (resc.y > MAP_H * T + 28) {
          victim.gone = true;
          sim.departed.add(resc.id);
          resc.done = true;
        }
      }
    }
    sim.rescues = sim.rescues.filter((resc) => !resc.done);
  }

  const MEDIC_LOOK: Look = { shirt: "#eef1f2", hair: "#2b2118", pants: "#eef1f2" };

  /** A crashed agent lies on its side: the idle pose turned a quarter turn. */
  function drawFallen(
    ctx: CanvasRenderingContext2D,
    assets: OfficeSheetAssets,
    victim: Actor,
    look: Look,
  ) {
    ctx.save();
    ctx.translate(Math.round(victim.x), Math.round(victim.y) - 6);
    ctx.rotate(-Math.PI / 2);
    ctx.globalAlpha = 0.9;
    drawEmployee(ctx, assets, DIRECTION_ROW.down, 2, 0, 12, "idle", look);
    ctx.restore();
    px(ctx, Math.round(victim.x) - 8, Math.round(victim.y) - 20, 3, 3, "#8fd49b");
    px(ctx, Math.round(victim.x) - 4, Math.round(victim.y) - 23, 2, 2, "#8fd49b");
  }

  /** Two medics in white walk to the victim and carry them out; a red cross marks them. */
  function drawMedic(
    ctx: CanvasRenderingContext2D,
    assets: OfficeSheetAssets,
    x: number,
    y: number,
    moving: boolean,
    frameT: number,
    dir: Dir,
  ) {
    drawShadow(ctx, x, y);
    const frame = moving ? Math.floor(frameT / 4) % 8 : 2;
    drawEmployee(
      ctx,
      assets,
      DIRECTION_ROW[dir],
      frame,
      x,
      y,
      moving ? "walk" : "idle",
      MEDIC_LOOK,
    );
    px(ctx, Math.round(x) - 1, Math.round(y) - 17, 3, 1, "#d03b3b");
    px(ctx, Math.round(x), Math.round(y) - 18, 1, 3, "#d03b3b");
  }

  function drawRescues(
    ctx: CanvasRenderingContext2D,
    sim: Simulation,
    now: number,
    assets: OfficeSheetAssets,
  ) {
    for (const resc of sim.rescues) {
      const victim = sim.actors.get(resc.id);
      const look = { shirt: resc.lane.color, hair: resc.lane.hair, pants: resc.lane.pants };
      if (victim && !victim.gone && resc.phase === "in") drawFallen(ctx, assets, victim, look);
      const dir: Dir = resc.phase === "in" ? "up" : "down";
      drawMedic(ctx, assets, resc.x - 9, resc.y, resc.moving, resc.frameT, dir);
      drawMedic(ctx, assets, resc.x + 9, resc.y, resc.moving, resc.frameT + 4, dir);
      if (victim && !victim.gone && resc.phase !== "in") {
        // Carried between the medics: drawn seated so the legs tuck up.
        drawEmployee(ctx, assets, DIRECTION_ROW.down, 2, resc.x, resc.y - 7, "sitting", look);
      }
      if (resc.phase === "load") drawBubble(ctx, { x: resc.x, y: resc.y + 14 }, "+ medic +");
    }
  }

  const STATUS_CHIP: Record<LaneStatus, string> = {
    working: "#72b7a2",
    pending: "#c9c1a6",
    waiting: "#e4bb6b",
    failed: "#df8588",
    idle: "#bbc3c7",
    departing: "#bbc3c7",
  };

  function drawWorld(
    ctx: CanvasRenderingContext2D,
    lanes: ReadonlyArray<Lane>,
    sim: Simulation,
    now: number,
    assets: OfficeSheetAssets | undefined,
    room: RoomCache | undefined,
    focusedId?: string | null,
  ) {
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, WORLD_W, WORLD_H);
    if (!assets || !room) {
      // Sheets are still loading (or failed). Keep the simulation ticking behind a
      // plain floor so agents are already in place when the artwork arrives.
      px(ctx, 0, 0, WORLD_W, WORLD_H, "#bbc4c5");
      ctx.fillStyle = "#6d7683";
      ctx.font = "8px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Setting up the office…", WORLD_W / 2, WORLD_H / 2);
      return;
    }
    ctx.drawImage(room.canvas, 0, 0, WORLD_W, WORLD_H);
    const day = daylight();
    drawWindows(ctx, day);
    drawWallClock(ctx);

    const actors: Array<{ lane: Lane; actor: Actor }> = [];
    for (const lane of lanes) {
      const actor = sim.actors.get(lane.id);
      if (actor && !actor.gone) actors.push({ lane, actor });
    }
    const focused = actors.find(({ lane }) => lane.id === focusedId);
    if (focused) {
      // Highlight the station in use: the research table a researcher is seated
      // at, or otherwise the agent's own desk.
      const claimedDesk = sim.deskClaims.get(focused.lane.id);
      const station = atResearchTable(focused.actor.tile)
        ? focused.actor.tile
        : claimedDesk === undefined
          ? undefined
          : DESK_SPOTS[claimedDesk];
      if (station) {
        const box = stationBox(station);
        ctx.strokeStyle = focused.lane.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(box.left - 2.5, box.top - 2.5, box.width + 5, box.height + 5);
      }
    }
    // Furniture is already in the room cache. Each actor is drawn over it, then
    // any piece that stands in front of the actor is repainted on top: the cost
    // scales with actors on screen, not with the size of the room.
    const visible = actors
      .filter(({ lane, actor }) => !(lane.status === "failed" && actor.rescueStarted))
      .map((entry) => ({ ...entry, position: actorPosition(entry.actor) }))
      .sort((a, b) => a.position.y - b.position.y);
    for (const { lane, actor, position } of visible) {
      drawSprite(
        ctx,
        { ...actor, ...position },
        { shirt: lane.color, hair: lane.hair, pants: lane.pants },
        assets,
      );
      const left = position.x - 16;
      const top = position.y - 31;
      for (const piece of room.furniture) {
        if (piece.depth <= position.y) continue;
        if (
          piece.left < left + 32 &&
          piece.left + piece.width > left &&
          piece.top < top + 33 &&
          piece.top + piece.height > top
        ) {
          piece.paint(ctx);
        }
      }
    }
    drawDeskScreens(ctx, lanes, sim);
    drawResearchPapers(ctx, sim, now);
    for (const { lane, actor } of actors) {
      if (actor.exiting || actor.rescueStarted) continue;
      const anchor = actorPosition(actor);
      const point = actor.seated ? { x: anchor.x + 10, y: anchor.y + 8 } : anchor;
      const color = STATUS_CHIP[lane.status];
      px(ctx, point.x - 3, point.y - 27, 6, 5, "#3c414f");
      if (lane.status === "waiting") {
        px(ctx, point.x - 1.5, point.y - 26, 1, 3, color);
        px(ctx, point.x + 0.5, point.y - 26, 1, 3, color);
      } else if (lane.status === "failed") {
        px(ctx, point.x - 0.5, point.y - 26, 1, 2, color);
        px(ctx, point.x - 0.5, point.y - 23.5, 1, 0.5, color);
      } else px(ctx, point.x - 2, point.y - 26, 4, 3, color);
    }
    drawSteam(ctx, sim, now);
    drawRescues(ctx, sim, now, assets);
    const dusk = (1 - day) * 0.1;
    if (lanes.length > 0 && dusk > 0.01)
      px(ctx, 0, 0, WORLD_W, WORLD_H, `rgba(9, 12, 24, ${dusk})`);
    if (lanes.length > 0 && day < 0.6) drawDeskLamps(ctx);
    if (lanes.length === 0) {
      px(ctx, 0, 0, WORLD_W, WORLD_H, "rgba(9, 12, 24, 0.45)");
      ctx.fillStyle = "#c9d0da";
      ctx.font = "8px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Office is quiet", WORLD_W / 2, WORLD_H / 2);
    }
  }

  function createSimulation(): Simulation {
    return {
      actors: new Map(),
      departed: new Set(),
      researchClaims: new Map(),
      deskClaims: new Map(),
      rescues: [],
      shuffles: new Map(),
      progressSeen: new Map(),
      ambient: { nextWanderAt: null, nextSteamAt: null, steamStart: null },
    };
  }

  function reflow(
    sim: Simulation,
    lanes: readonly Lane[],
    oldWidth: number,
    oldHeight: number,
    oldCounts?: { desks: number; researchTables: number },
  ) {
    const floor = collectTiles(",", ".", "o", "d", "m");
    sim.rescues = [];
    // Seat indices survive a resize as long as the seat count did not change;
    // otherwise they refer to the old grid and are re-claimed.
    if (oldCounts?.desks !== DESK_SPOTS.length) sim.deskClaims.clear();
    if (oldCounts?.researchTables !== RESEARCH_TABLES.length) sim.researchClaims.clear();
    for (const [id, actor] of sim.actors) {
      const lane = lanes.find((candidate) => candidate.id === id);
      if (!lane) {
        sim.actors.delete(id);
        continue;
      }
      actor.cafeSpot = null;
      actor.rescueStarted = false;
      let target: readonly [number, number];
      if (actor.exiting) target = ENTRY;
      else if (actor.seated) target = zoneTarget(lane, actor, lanes, sim);
      else {
        const x = ((actor.x / oldWidth) * WORLD_W) / T;
        const y = ((actor.y / oldHeight) * WORLD_H) / T;
        target = floor.reduce(
          (best, tile) =>
            Math.hypot(tile[0] - x, tile[1] - y) < Math.hypot(best[0] - x, best[1] - y)
              ? tile
              : best,
          floor[0]!,
        );
      }
      actor.tile = [target[0], target[1]];
      const point = tileCenter(target);
      actor.x = point.x;
      actor.y = point.y;
      actor.path = [];
      actor.goal = null;
    }
  }
  return {
    layout,
    width: WORLD_W,
    height: WORLD_H,
    createSimulation,
    reflow,
    updateActors,
    rescueTick,
    drawWorld,
    paintRoom,
    isSettled,
    nextWakeAt,
    hitTest,
    bfs,
  };
}

import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import officeCredits from "./assets/lpc/CREDITS.md?raw";
import { createOffice, officeRoster, type RoomCache } from "./agentOfficeEngine";
import { officeLayout } from "./officeLayout";
import {
  loadOfficeSheets,
  releaseCharacterAtlases,
  type OfficeSheetAssets,
} from "./officeSheetAssets";

type Office = ReturnType<typeof createOffice>;
type Simulation = ReturnType<Office["createSimulation"]>;

/** Height reserved above the room for the agent picker, in CSS pixels. */
const TOOLBAR_HEIGHT = 40;
/** Inset between the host edge and the room on every side, in CSS pixels. */
const ROOM_INSET = 16;
const LICENSE_URL = "https://static.opengameart.org/OGA-BY-3.0.txt";

type SheetsState = "loading" | "ready" | "failed";

/**
 * Canvas host for the agent office. The runtime is created once per mount and
 * reads the latest lanes through a ref, so agent progress updates never rebuild
 * the room cache, observers, or simulation. Frames are scheduled only while
 * something is in transition (an agent walking, a rescue, a paper shuffle); once
 * the room settles the loop stops and is woken by lane, pointer, size, or asset
 * events. A quiet office costs nothing.
 */
export function AgentVisualizationPanel({ model }: { model: AgentPanelModel }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const { lanes, omitted } = useMemo(() => officeRoster(model), [model]);
  const lanesRef = useRef(lanes);
  const [sheetsState, setSheetsState] = useState<SheetsState>("loading");
  const [creditsOpen, setCreditsOpen] = useState(false);
  const retrySheetsRef = useRef<() => void>(() => undefined);
  /** Asks the render loop for a frame; set by the mount effect. */
  const wakeRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    lanesRef.current = lanes;
    wakeRef.current();
  }, [lanes]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const focusedId = hoveredId ?? selectedId;
  const focusedLane = lanes.find((lane) => lane.id === focusedId);
  const focusRef = useRef<string | null>(null);
  useEffect(() => {
    focusRef.current = focusedId;
    wakeRef.current();
  }, [focusedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;
    const roomSize = () => {
      const bounds = host.getBoundingClientRect();
      return {
        bounds,
        width: Math.max(1, bounds.width - ROOM_INSET),
        height: Math.max(1, bounds.height - ROOM_INSET - TOOLBAR_HEIGHT),
      };
    };
    const initialSize = roomSize();
    const runtime: { office: Office; sim: Simulation } = (() => {
      const office = createOffice(
        officeLayout(initialSize.width, initialSize.height, lanesRef.current.length),
      );
      return { office, sim: office.createSimulation() };
    })();
    let frame = 0;
    let scheduled = false;
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let inView = true;
    let lastDraw = 0;
    let lastTick = performance.now();
    let accumulated = 0;
    let assets: OfficeSheetAssets | undefined;
    let room: RoomCache | undefined;
    let viewport = { scale: 1, ox: 0, oy: 0 };
    let lastLaneCount = lanesRef.current.length;
    let lastDpr = window.devicePixelRatio || 1;
    const wake = () => {
      if (disposed || scheduled) return;
      if (wakeTimer !== undefined) {
        clearTimeout(wakeTimer);
        wakeTimer = undefined;
      }
      scheduled = true;
      frame = requestAnimationFrame(loop);
    };
    wakeRef.current = wake;
    const cacheRoom = () => {
      if (!assets) return;
      const canvas = document.createElement("canvas");
      canvas.width = runtime.office.width * 2;
      canvas.height = runtime.office.height * 2;
      const roomCtx = canvas.getContext("2d");
      if (!roomCtx) return;
      roomCtx.scale(2, 2);
      room = { canvas, furniture: runtime.office.paintRoom(roomCtx, assets) };
    };
    const resize = () => {
      const { bounds, width, height } = roomSize();
      const lanes = lanesRef.current;
      const layout = officeLayout(width, height, lanes.length);
      if (runtime.office.layout.key !== layout.key) {
        const previous = runtime.office;
        runtime.office = createOffice(layout);
        runtime.office.reflow(runtime.sim, lanes, previous.width, previous.height, {
          desks: previous.layout.desks.length,
          researchTables: previous.layout.researchTables.length,
        });
        cacheRoom();
      }
      const dpr = window.devicePixelRatio || 1;
      lastDpr = dpr;
      canvas.width = Math.max(1, Math.round(bounds.width * dpr));
      canvas.height = Math.max(1, Math.round(bounds.height * dpr));
      const scale = Math.min(width / runtime.office.width, height / runtime.office.height);
      const ox = (bounds.width - runtime.office.width * scale) / 2;
      const oy =
        TOOLBAR_HEIGHT + (bounds.height - TOOLBAR_HEIGHT - runtime.office.height * scale) / 2;
      viewport = { scale, ox, oy };
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
      wake();
    };
    const agentAt = (event: PointerEvent | MouseEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return runtime.office.hitTest(
        runtime.sim,
        (event.clientX - bounds.left - viewport.ox) / viewport.scale,
        (event.clientY - bounds.top - viewport.oy) / viewport.scale,
      );
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const id = agentAt(event);
      setHoveredId(id);
      canvas.style.cursor = id ? "pointer" : "default";
    };
    const dprChanged = () => {
      if ((window.devicePixelRatio || 1) !== lastDpr) resize();
    };
    const visibilityChanged = () => {
      if (!document.hidden) wake();
    };
    const pointerLeave = () => setHoveredId(null);
    const select = (event: MouseEvent) => {
      const id = agentAt(event);
      setSelectedId((previous) => (previous === id ? null : id));
      setHoveredId(null);
    };
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerleave", pointerLeave);
    canvas.addEventListener("click", select);
    window.addEventListener("resize", dprChanged);
    document.addEventListener("visibilitychange", visibilityChanged);
    const loadSheets = () => {
      setSheetsState("loading");
      void loadOfficeSheets()
        .then((loaded) => {
          if (disposed) return;
          assets = loaded;
          cacheRoom();
          setSheetsState("ready");
          wake();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          console.warn("Office sheets unavailable", error);
          setSheetsState("failed");
        });
    };
    retrySheetsRef.current = loadSheets;
    loadSheets();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      if (inView) wake();
    });
    visibilityObserver.observe(host);
    const loop = (now: number) => {
      scheduled = false;
      if (disposed) return;
      if (document.hidden || !inView) {
        // Hidden: stop entirely. Visibility and intersection changes wake us.
        lastTick = now;
        accumulated = 0;
        return;
      }
      if (now - lastDraw < 1000 / 30) {
        wake();
        return;
      }
      lastDraw = now;
      accumulated += Math.min(100, now - lastTick);
      lastTick = now;
      const lanes = lanesRef.current;
      // More agents can mean more desks. The resize path compares layout keys, so
      // this only reflows when the desk count actually changes the room.
      if (lanes.length !== lastLaneCount) {
        lastLaneCount = lanes.length;
        resize();
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      while (accumulated >= 1000 / 60) {
        runtime.office.updateActors(runtime.sim, lanes, now);
        runtime.office.rescueTick(runtime.sim, lanes, now);
        accumulated -= 1000 / 60;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, runtime.office.width, runtime.office.height);
      ctx.clip();
      // Focus follows the roster, not the actor: an agent the medics carried out
      // is still selectable and its details still read "crashed".
      if (focusRef.current && !lanes.some((lane) => lane.id === focusRef.current)) {
        setHoveredId(null);
        setSelectedId(null);
      }
      runtime.office.drawWorld(ctx, lanes, runtime.sim, now, assets, room, focusRef.current);
      ctx.restore();
      // Keep going only while something is still moving. Otherwise sleep until the
      // next scheduled ambient event (a wander, a steam puff, a doze, the clock's
      // next minute) or until an external event wakes us.
      if (!runtime.office.isSettled(runtime.sim, lanes, now)) {
        wake();
        return;
      }
      const next = runtime.office.nextWakeAt(runtime.sim, lanes, now);
      if (next !== null && wakeTimer === undefined) {
        wakeTimer = setTimeout(() => {
          wakeTimer = undefined;
          wake();
        }, next - now);
      }
    };
    resize();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (wakeTimer !== undefined) clearTimeout(wakeTimer);
      observer.disconnect();
      visibilityObserver.disconnect();
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerleave", pointerLeave);
      canvas.removeEventListener("click", select);
      window.removeEventListener("resize", dprChanged);
      document.removeEventListener("visibilitychange", visibilityChanged);
      wakeRef.current = () => undefined;
      releaseCharacterAtlases();
    };
  }, []);

  const pickableLanes = lanes.filter((lane) => lane.status !== "departing");

  return (
    <div ref={hostRef} className="relative h-full min-h-0 overflow-hidden bg-[#242632]">
      <canvas
        ref={canvasRef}
        aria-label="Agent office visualization"
        className="block h-full w-full"
      />
      <div className="absolute inset-x-0 top-0 flex h-10 items-center border-b border-border bg-background px-3">
        <select
          aria-label="Select office agent"
          disabled={pickableLanes.length === 0}
          value={pickableLanes.some((lane) => lane.id === selectedId) ? (selectedId ?? "") : ""}
          onChange={(event) => {
            setSelectedId(event.target.value || null);
            setHoveredId(null);
          }}
          className="h-7 max-w-full rounded border border-border bg-background px-2 text-xs text-foreground disabled:opacity-60"
        >
          <option value="">{pickableLanes.length === 0 ? "Office is quiet" : "Office"}</option>
          {pickableLanes.map((lane) => (
            <option key={lane.id} value={lane.id}>
              {lane.label}
            </option>
          ))}
        </select>
        {omitted > 0 && (
          <span className="ml-3 truncate text-[11px] text-muted-foreground">
            {omitted} more not shown
          </span>
        )}
      </div>
      {sheetsState === "failed" && (
        <div className="absolute inset-x-0 top-10 bottom-0 flex flex-col items-center justify-center gap-2 text-zinc-300">
          <p className="text-xs">The office artwork could not be loaded.</p>
          <button
            type="button"
            onClick={() => retrySheetsRef.current()}
            className="rounded border border-zinc-500 px-2 py-1 text-xs hover:bg-zinc-700"
          >
            Retry
          </button>
        </div>
      )}
      {focusedLane && (
        <div className="absolute bottom-8 left-3 right-3 flex items-start gap-3 rounded-md border border-border bg-background/95 p-3 text-foreground shadow-sm">
          <span
            className="mt-1 size-2 shrink-0 rounded-full"
            style={{ backgroundColor: focusedLane.color }}
          />
          <div className="min-w-0 flex-1">
            <div className="break-words text-xs font-medium">{focusedLane.label}</div>
            <div className="mt-0.5 text-[11px] capitalize text-muted-foreground">
              {focusedLane.status}
            </div>
            {focusedLane.bubbleText && (
              <p className="mt-1 line-clamp-3 break-words text-xs text-muted-foreground">
                {focusedLane.bubbleText}
              </p>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Clear agent selection"
                  onClick={() => {
                    setSelectedId(null);
                    setHoveredId(null);
                  }}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup>Clear agent selection</TooltipPopup>
          </Tooltip>
        </div>
      )}
      <div className="absolute bottom-2 right-3 flex gap-2 text-[10px] text-zinc-400">
        <button
          type="button"
          onClick={() => setCreditsOpen(true)}
          className="underline-offset-2 hover:text-zinc-200 hover:underline"
        >
          Art credits
        </button>
        <a
          href={LICENSE_URL}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-2 hover:text-zinc-200 hover:underline"
        >
          OGA-BY 3.0
        </a>
      </div>
      <Dialog open={creditsOpen} onOpenChange={setCreditsOpen}>
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Office artwork credits</DialogTitle>
            <DialogDescription>
              LPC Revised artwork under OGA-BY 3.0. Full upstream attribution follows.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground">
              {officeCredits}
            </pre>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

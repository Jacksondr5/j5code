import { Link } from "@tanstack/react-router";
import { BellIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useSidebar } from "../../components/ui/sidebar";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readOpenInboxCount } from "./humanInboxCountClient";
import { HUMAN_INBOX_REFRESH_EVENT } from "./humanInboxRefresh";
import { useWorkflowQuery, workflowListAtom } from "../workflow/queries";

export const COUNT_POLL_INTERVAL_MS = 7_500;

export const shouldShowOpenInboxCount = (count: number | null) => count !== null && count > 0;

interface GateIdentityInput {
  readonly id: string;
  readonly gateRevision: number | null;
}

export interface WorkflowGateBellState {
  readonly environmentId: string;
  readonly seenGateRevisions: ReadonlyMap<string, number>;
}

export const observeWorkflowGates = (
  previous: WorkflowGateBellState | null,
  environmentId: string,
  runs: ReadonlyArray<GateIdentityInput>,
): { readonly state: WorkflowGateBellState; readonly shouldRing: boolean } => {
  if (previous === null || previous.environmentId !== environmentId)
    return {
      state: {
        environmentId,
        seenGateRevisions: new Map(
          runs.flatMap((run) =>
            run.gateRevision === null ? [] : [[run.id, run.gateRevision] as const],
          ),
        ),
      },
      shouldRing: false,
    };

  const seenGateRevisions = new Map(previous.seenGateRevisions);
  let shouldRing = false;
  for (const run of runs) {
    if (run.gateRevision === null) continue;
    const seenRevision = seenGateRevisions.get(run.id);
    if (seenRevision !== undefined && run.gateRevision <= seenRevision) continue;
    seenGateRevisions.set(run.id, run.gateRevision);
    shouldRing = true;
  }
  return { state: { environmentId, seenGateRevisions }, shouldRing };
};

const playWorkflowGateBell = (context: AudioContext | null) => {
  if (context === null) return;
  void context
    .resume()
    .then(() => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.4);
    })
    .catch(() => undefined);
};

export function HumanInboxBell({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentId = usePrimaryEnvironmentId();
  const workflowGates = useWorkflowQuery(
    environmentId === null
      ? null
      : workflowListAtom({
          environmentId,
          input: { squadronId: "", search: "", status: "waiting_approval", page: 0, pageSize: 100 },
        }),
  );
  const workflowGateBellState = useRef<WorkflowGateBellState | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const [humanCount, setHumanCount] = useState<number | null>(null);

  useEffect(() => {
    const stopArming = () => {
      window.removeEventListener("pointerdown", armAudio);
      window.removeEventListener("keydown", armAudio);
    };
    const armAudio = () => {
      stopArming();
      const AudioContextConstructor = window.AudioContext;
      if (AudioContextConstructor === undefined) return;
      try {
        audioContext.current = new AudioContextConstructor();
      } catch {
        return;
      }
      void audioContext.current.resume().catch(() => undefined);
    };
    window.addEventListener("pointerdown", armAudio);
    window.addEventListener("keydown", armAudio);
    return () => {
      stopArming();
      const context = audioContext.current;
      audioContext.current = null;
      if (context !== null) void context.close().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (environmentId === null) {
      workflowGateBellState.current = null;
      return;
    }
    if (workflowGates.data === null) return;
    const observation = observeWorkflowGates(
      workflowGateBellState.current,
      environmentId,
      workflowGates.data.runs,
    );
    workflowGateBellState.current = observation.state;
    if (observation.shouldRing) playWorkflowGateBell(audioContext.current);
  }, [environmentId, workflowGates.data]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let refreshQueued = false;
    let interval: number | undefined;
    const refresh = () => {
      if (!active) return;
      if (inFlight) {
        refreshQueued = true;
        return;
      }
      inFlight = true;
      void readOpenInboxCount()
        .then((response) => {
          if (active) setHumanCount(response.count);
        })
        .catch(() => {
          if (active) setHumanCount(null);
        })
        .finally(() => {
          inFlight = false;
          if (active && refreshQueued) {
            refreshQueued = false;
            refresh();
          }
        });
    };
    const syncInterval = () => {
      window.clearInterval(interval);
      interval =
        document.visibilityState === "visible"
          ? window.setInterval(refresh, COUNT_POLL_INTERVAL_MS)
          : undefined;
    };
    const refreshVisibleWindow = () => {
      if (document.visibilityState === "visible") refresh();
      syncInterval();
    };
    refresh();
    syncInterval();
    window.addEventListener("focus", refreshVisibleWindow);
    window.addEventListener(HUMAN_INBOX_REFRESH_EVENT, refresh);
    document.addEventListener("visibilitychange", refreshVisibleWindow);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleWindow);
      window.removeEventListener(HUMAN_INBOX_REFRESH_EVENT, refresh);
      document.removeEventListener("visibilitychange", refreshVisibleWindow);
    };
  }, []);

  const count =
    humanCount === null || workflowGates.data === null
      ? null
      : humanCount + workflowGates.data.total;

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const label = count === null ? "Open inbox" : `Open inbox, ${count} open`;
  return (
    <Link
      aria-label={label}
      className={cn(
        "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md outline-hidden transition-colors [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-ring",
        onBackdrop
          ? "text-white/80 hover:bg-white/15 hover:text-white"
          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      onClick={closeMobileSidebar}
      title={label}
      to="/inbox"
    >
      <BellIcon aria-hidden className="size-4" />
      {shouldShowOpenInboxCount(count) ? (
        <span className="absolute -end-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] font-semibold leading-none text-primary-foreground tabular-nums ring-2 ring-sidebar">
          {count}
        </span>
      ) : null}
    </Link>
  );
}

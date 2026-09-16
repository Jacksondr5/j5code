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
const CHIME_FREQUENCIES_HZ = [523.25, 659.25] as const;
const CHIME_NOTE_SECONDS = 0.12;
const CHIME_GAP_SECONDS = 0.04;
const CHIME_GAIN = 0.08;

export interface GateNotificationState {
  readonly environmentId: string;
  readonly seen: ReadonlySet<string>;
}

interface ApprovalGate {
  readonly id: string;
  readonly gateRevision: number | null;
}

export const observeApprovalGates = (
  previous: GateNotificationState | null,
  environmentId: string,
  gates: ReadonlyArray<ApprovalGate>,
) => {
  const keys = gates.map((gate) => `${gate.id}:${gate.gateRevision}`);
  const sameEnvironment = previous?.environmentId === environmentId;
  return {
    state: {
      environmentId,
      seen: new Set(sameEnvironment ? [...previous.seen, ...keys] : keys),
    },
    shouldNotify: sameEnvironment && keys.some((key) => !previous.seen.has(key)),
  };
};

const playGateChime = async () => {
  const AudioContextConstructor = window.AudioContext;
  if (AudioContextConstructor === undefined) return;

  let context: AudioContext | undefined;
  let oscillator: OscillatorNode | undefined;
  let gain: GainNode | undefined;
  try {
    context = new AudioContextConstructor();
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") return;

    const start = context.currentTime;
    const firstEnd = start + CHIME_NOTE_SECONDS;
    const secondStart = firstEnd + CHIME_GAP_SECONDS;
    const end = secondStart + CHIME_NOTE_SECONDS;
    oscillator = context.createOscillator();
    gain = context.createGain();
    oscillator.frequency.setValueAtTime(CHIME_FREQUENCIES_HZ[0], start);
    oscillator.frequency.setValueAtTime(CHIME_FREQUENCIES_HZ[1], secondStart);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(CHIME_GAIN, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, firstEnd);
    gain.gain.setValueAtTime(0.0001, secondStart);
    gain.gain.exponentialRampToValueAtTime(CHIME_GAIN, secondStart + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end);
    await new Promise<void>((resolve) => {
      oscillator?.addEventListener("ended", () => resolve(), { once: true });
    });
  } catch {
    // Audio is best-effort and must never disrupt inbox updates.
  } finally {
    oscillator?.disconnect();
    gain?.disconnect();
    if (context?.state !== "closed") await context?.close().catch(() => undefined);
  }
};

export const shouldShowOpenInboxCount = (count: number | null) => count !== null && count > 0;

export function HumanInboxBell({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentId = usePrimaryEnvironmentId();
  const workflowGates = useWorkflowQuery(
    environmentId === null
      ? null
      : workflowListAtom({
          environmentId,
          input: {
            squadronId: "",
            search: "",
            status: "waiting_approval",
            page: 0,
            pageSize: 20,
          },
        }),
  );
  const [humanCount, setHumanCount] = useState<number | null>(null);
  const gateNotifications = useRef<GateNotificationState | null>(null);
  const audioArmed = useRef(false);

  useEffect(() => {
    const armAudio = () => {
      audioArmed.current = true;
      window.removeEventListener("pointerdown", armAudio);
      window.removeEventListener("keydown", armAudio);
    };
    window.addEventListener("pointerdown", armAudio);
    window.addEventListener("keydown", armAudio);
    return () => {
      window.removeEventListener("pointerdown", armAudio);
      window.removeEventListener("keydown", armAudio);
    };
  }, []);

  useEffect(() => {
    if (environmentId === null) {
      gateNotifications.current = null;
      return;
    }
    if (workflowGates.data === null) return;
    const observation = observeApprovalGates(
      gateNotifications.current,
      environmentId,
      workflowGates.data.runs,
    );
    gateNotifications.current = observation.state;
    if (observation.shouldNotify && audioArmed.current) void playGateChime();
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

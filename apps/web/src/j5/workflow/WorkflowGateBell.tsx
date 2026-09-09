import type { WorkflowEntry } from "@j5/workflow-contracts/sidebar";
import { useEffect, useRef } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useWorkflowQuery, workflowListAtom } from "./queries";

type GateLedger = Readonly<Record<string, number>>;

interface GateObservation {
  readonly ledger: GateLedger;
  readonly newGateCount: number;
}

interface EnvironmentObservation {
  readonly initialized: boolean;
  readonly ledger: GateLedger;
}

export const workflowGateStorageKey = (environmentId: string) =>
  `t3code:j5-workflow-gates:v1:${environmentId}`;

export const readWorkflowGateLedger = (
  storage: Storage | undefined,
  environmentId: string,
): GateLedger => {
  if (storage === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(workflowGateStorageKey(environmentId)) ?? "{}",
    );
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
};

export const writeWorkflowGateLedger = (
  storage: Storage | undefined,
  environmentId: string,
  ledger: GateLedger,
): void => {
  try {
    storage?.setItem(workflowGateStorageKey(environmentId), JSON.stringify(ledger));
  } catch {
    // Gate notifications are best effort and must not interfere with workflow polling.
  }
};

export const observeWorkflowGates = (
  previous: GateLedger,
  runs: ReadonlyArray<Pick<WorkflowEntry, "id" | "status" | "gateRevision">>,
  notify: boolean,
): GateObservation => {
  let next: Record<string, number> | undefined;
  let newGateCount = 0;
  for (const run of runs) {
    if (run.status !== "waiting_approval" || run.gateRevision === null) continue;
    if (previous[run.id] === run.gateRevision) continue;
    next ??= { ...previous };
    next[run.id] = run.gateRevision;
    if (notify) newGateCount += 1;
  }
  return { ledger: next ?? previous, newGateCount };
};

type AudioContextFactory = () => AudioContext | undefined;

const createAudioContext: AudioContextFactory = () => {
  if (typeof window === "undefined" || window.AudioContext === undefined) return undefined;
  return new window.AudioContext();
};

const closeAudioContext = (context: AudioContext) => {
  void context.close().catch(() => undefined);
};

export const playWorkflowGateBell = async (
  createContext: AudioContextFactory = createAudioContext,
): Promise<boolean> => {
  let context: AudioContext | undefined;
  try {
    context = createContext();
    if (context === undefined) return false;
    if (context.state === "suspended") await context.resume();
    if ((context as AudioContext).state !== "running") {
      closeAudioContext(context);
      return false;
    }

    const activeContext = context;
    const oscillator = activeContext.createOscillator();
    const gain = activeContext.createGain();
    const start = activeContext.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, start);
    gain.gain.setValueAtTime(0.12, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
    oscillator.connect(gain);
    gain.connect(activeContext.destination);
    oscillator.addEventListener("ended", () => closeAudioContext(activeContext));
    oscillator.start(start);
    oscillator.stop(start + 0.45);
    return true;
  } catch {
    if (context !== undefined) closeAudioContext(context);
    return false;
  }
};

const resolveStorage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export function WorkflowGateBell() {
  const environmentId = usePrimaryEnvironmentId();
  const observations = useRef(new Map<string, EnvironmentObservation>());
  const query = useWorkflowQuery(
    environmentId === null
      ? null
      : workflowListAtom({
          environmentId,
          input: { squadronId: "", search: "", status: "", page: 0, pageSize: 100 },
        }),
  );

  useEffect(() => {
    if (environmentId === null || query.data === null) return;
    const storage = resolveStorage();
    const prior = observations.current.get(environmentId) ?? {
      initialized: false,
      ledger: readWorkflowGateLedger(storage, environmentId),
    };
    const next = observeWorkflowGates(prior.ledger, query.data.runs, prior.initialized);
    observations.current.set(environmentId, { initialized: true, ledger: next.ledger });
    if (next.ledger !== prior.ledger) {
      writeWorkflowGateLedger(storage, environmentId, next.ledger);
    }
    if (next.newGateCount > 0) void playWorkflowGateBell();
  }, [environmentId, query.data]);

  return null;
}

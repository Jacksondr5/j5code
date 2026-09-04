import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

type Projection = OrchestrationV2ThreadProjection;

// Mirrors threadWorkflows.ts's active-run and session resolution on purpose:
// upstream tests mock that module away, and this J5 module must stay callable
// from any surface that renders queue or composer state.
const ACTIVE_RUN_STATUSES = new Set<Projection["runs"][number]["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

const activeThreadRun = (projection: Projection) =>
  projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;

const turnCapabilities = (projection: Projection, activeRun: Projection["runs"][number]) => {
  const providerThreadId = activeRun.providerThreadId ?? projection.thread.activeProviderThreadId;
  const providerThread =
    (providerThreadId === null
      ? null
      : projection.providerThreads.find((thread) => thread.id === providerThreadId)) ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.providerSessionId !== null,
    ) ??
    null;
  const sessionId = providerThread?.providerSessionId ?? null;
  const session =
    sessionId !== null
      ? projection.providerSessions.find((candidate) => candidate.id === sessionId)
      : projection.providerSessions.findLast(
          (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
        );
  return session?.capabilities.turns;
};

/** What an explicit steer does on the current provider (queue-vs-steer ruling QS4). */
export type SteerAct = "steer-now" | "interrupt-restart";

/** Why an active run cannot take a steer right now (queue-vs-steer ruling QS3). */
export type NotSteerablePhase = "preparing" | "starting" | "finalizing" | "waiting";

export type SteerState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "steerable";
      readonly act: SteerAct;
      readonly runId: Projection["runs"][number]["id"];
    }
  | {
      readonly kind: "not-steerable";
      readonly phase: NotSteerablePhase;
      readonly runId: Projection["runs"][number]["id"];
    };

const TERMINAL_PROVIDER_TURN_STATUSES = new Set<Projection["providerTurns"][number]["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

/**
 * Derives the truthful steer state for a thread from its projection. "Steerable"
 * mirrors the server's own gate (run running, active attempt, provider turn
 * running); everything else with an active run names the phase the run is in.
 */
export function deriveSteerState(projection: Projection): SteerState {
  const activeRun = activeThreadRun(projection);
  if (activeRun === null) return { kind: "idle" };

  const attemptTurns =
    activeRun.activeAttemptId === null
      ? []
      : projection.providerTurns.filter((turn) => turn.runAttemptId === activeRun.activeAttemptId);
  const hasRunningProviderTurn = attemptTurns.some((turn) => turn.status === "running");

  if (activeRun.status === "running" && hasRunningProviderTurn) {
    const capabilities = turnCapabilities(projection, activeRun);
    return {
      kind: "steerable",
      act: capabilities?.supportsActiveSteering === true ? "steer-now" : "interrupt-restart",
      runId: activeRun.id,
    };
  }

  const providerTurnEnded = attemptTurns.some((turn) =>
    TERMINAL_PROVIDER_TURN_STATUSES.has(turn.status),
  );
  const phase: NotSteerablePhase =
    activeRun.status === "preparing"
      ? "preparing"
      : activeRun.status === "starting"
        ? "starting"
        : providerTurnEnded
          ? "finalizing"
          : activeRun.status === "waiting"
            ? "waiting"
            : "starting";
  return { kind: "not-steerable", phase, runId: activeRun.id };
}

/** Label for the explicit steer control; says what the act does on this provider. */
export function steerActLabel(act: SteerAct): string {
  return act === "steer-now" ? "Steer now" : "Interrupt and restart with this message";
}

/** Keyboard hint shown beside the composer while a turn is active. */
export function steerShortcutHint(act: SteerAct): string {
  return act === "steer-now" ? "to steer now" : "to interrupt and restart with this message";
}

/** Sentence describing why nothing is steerable right now. */
export function notSteerableStateText(phase: NotSteerablePhase): string {
  switch (phase) {
    case "preparing":
      return "Not generating yet — preparing the workspace";
    case "starting":
      return "Not generating yet — starting";
    case "finalizing":
      return "Finishing up — checkpointing";
    case "waiting":
      return "Waiting on the provider — not generating";
  }
}

/** Tooltip for a queued row's steer control in every state. */
export function queuedRowSteerTitle(state: SteerState): string {
  switch (state.kind) {
    case "idle":
      return "There is no active run to steer";
    case "steerable":
      return state.act === "steer-now"
        ? "Send now as a steer"
        : "Interrupt the turn and restart it with this message";
    case "not-steerable":
      return notSteerableStateText(state.phase);
  }
}

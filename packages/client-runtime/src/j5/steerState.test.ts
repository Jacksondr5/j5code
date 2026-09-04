import { describe, expect, it } from "vite-plus/test";

import {
  deriveSteerState,
  notSteerableStateText,
  queuedRowSteerTitle,
  steerActLabel,
  steerShortcutHint,
} from "./steerState.ts";

/** Turn capabilities as the adapters declare them (Grok spreads the ACP set). */
const PROVIDER_TURN_CAPABILITIES = {
  claude: { supportsActiveSteering: true, supportsSteeringByInterruptRestart: false },
  codex: { supportsActiveSteering: true, supportsSteeringByInterruptRestart: true },
  opencode: { supportsActiveSteering: true, supportsSteeringByInterruptRestart: true },
  cursor: { supportsActiveSteering: false, supportsSteeringByInterruptRestart: true },
  acp: { supportsActiveSteering: false, supportsSteeringByInterruptRestart: true },
  grok: { supportsActiveSteering: false, supportsSteeringByInterruptRestart: true },
} as const;

const projection = (input: {
  readonly runStatus?: "preparing" | "starting" | "running" | "waiting" | "completed";
  readonly providerTurnStatus?: "pending" | "running" | "completed" | "interrupted" | null;
  readonly turns?: (typeof PROVIDER_TURN_CAPABILITIES)[keyof typeof PROVIDER_TURN_CAPABILITIES];
}) =>
  ({
    thread: { id: "thread", activeProviderThreadId: "provider-thread" },
    runs: [
      {
        id: "run-active",
        status: input.runStatus ?? "running",
        providerThreadId: "provider-thread",
        activeAttemptId: "attempt-active",
        ordinal: 1,
      },
    ],
    messages: [],
    providerTurns:
      input.providerTurnStatus === null || input.providerTurnStatus === undefined
        ? []
        : [
            {
              id: "provider-turn",
              runAttemptId: "attempt-active",
              status: input.providerTurnStatus,
            },
          ],
    providerThreads: [
      {
        id: "provider-thread",
        appThreadId: "thread",
        providerSessionId: "session",
      },
    ],
    providerSessions: [
      {
        id: "session",
        status: "ready",
        capabilities: {
          turns: {
            supportsQueuedMessages: true,
            ...(input.turns ?? PROVIDER_TURN_CAPABILITIES.claude),
          },
        },
      },
    ],
  }) as never;

describe("deriveSteerState", () => {
  it("is idle without an active run", () => {
    expect(
      deriveSteerState(projection({ runStatus: "completed", providerTurnStatus: null })),
    ).toEqual({
      kind: "idle",
    });
  });

  it("names the act per provider capability while a provider turn is running", () => {
    for (const provider of ["claude", "codex", "opencode"] as const) {
      expect(
        deriveSteerState(
          projection({
            providerTurnStatus: "running",
            turns: PROVIDER_TURN_CAPABILITIES[provider],
          }),
        ),
      ).toEqual({ kind: "steerable", act: "steer-now", runId: "run-active" });
    }
    for (const provider of ["cursor", "acp", "grok"] as const) {
      expect(
        deriveSteerState(
          projection({
            providerTurnStatus: "running",
            turns: PROVIDER_TURN_CAPABILITIES[provider],
          }),
        ),
      ).toEqual({ kind: "steerable", act: "interrupt-restart", runId: "run-active" });
    }
  });

  it("names the phase when the active run has nothing steerable", () => {
    expect(
      deriveSteerState(projection({ runStatus: "preparing", providerTurnStatus: null })),
    ).toEqual({ kind: "not-steerable", phase: "preparing", runId: "run-active" });
    expect(
      deriveSteerState(projection({ runStatus: "starting", providerTurnStatus: null })),
    ).toEqual({
      kind: "not-steerable",
      phase: "starting",
      runId: "run-active",
    });
    // The hand-off window: the run is running but the adapter has not reported a turn yet.
    expect(
      deriveSteerState(projection({ runStatus: "running", providerTurnStatus: null })),
    ).toEqual({
      kind: "not-steerable",
      phase: "starting",
      runId: "run-active",
    });
    expect(
      deriveSteerState(projection({ runStatus: "running", providerTurnStatus: "pending" })),
    ).toEqual({ kind: "not-steerable", phase: "starting", runId: "run-active" });
    // Provider finished, run still open for checkpoint capture.
    expect(
      deriveSteerState(projection({ runStatus: "running", providerTurnStatus: "completed" })),
    ).toEqual({ kind: "not-steerable", phase: "finalizing", runId: "run-active" });
    expect(
      deriveSteerState(projection({ runStatus: "waiting", providerTurnStatus: "completed" })),
    ).toEqual({ kind: "not-steerable", phase: "finalizing", runId: "run-active" });
    expect(
      deriveSteerState(projection({ runStatus: "waiting", providerTurnStatus: null })),
    ).toEqual({
      kind: "not-steerable",
      phase: "waiting",
      runId: "run-active",
    });
  });
});

describe("steer copy", () => {
  it("says what the act does on this provider", () => {
    expect(steerActLabel("steer-now")).toBe("Steer now");
    expect(steerActLabel("interrupt-restart")).toBe("Interrupt and restart with this message");
    expect(steerShortcutHint("steer-now")).toBe("to steer now");
    expect(steerShortcutHint("interrupt-restart")).toBe(
      "to interrupt and restart with this message",
    );
  });

  it("states the actual phase when nothing is steerable", () => {
    expect(notSteerableStateText("preparing")).toBe("Not generating yet — preparing the workspace");
    expect(notSteerableStateText("starting")).toBe("Not generating yet — starting");
    expect(notSteerableStateText("finalizing")).toBe("Finishing up — checkpointing");
    expect(notSteerableStateText("waiting")).toBe("Waiting on the provider — not generating");
    expect(queuedRowSteerTitle({ kind: "idle" })).toBe("There is no active run to steer");
    expect(
      queuedRowSteerTitle({ kind: "not-steerable", phase: "finalizing", runId: "run" as never }),
    ).toBe("Finishing up — checkpointing");
    expect(
      queuedRowSteerTitle({ kind: "steerable", act: "steer-now", runId: "run" as never }),
    ).toBe("Send now as a steer");
    expect(
      queuedRowSteerTitle({ kind: "steerable", act: "interrupt-restart", runId: "run" as never }),
    ).toBe("Interrupt the turn and restart it with this message");
  });
});

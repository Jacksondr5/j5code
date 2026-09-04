import type { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerSteerHint } from "./steerHint";

const runId = "run:test" as RunId;

describe("composerSteerHint", () => {
  it("names the chord's act per provider while a steer is possible", () => {
    expect(composerSteerHint({ kind: "steerable", act: "steer-now", runId })).toEqual({
      shortcut: true,
      text: "to steer now",
    });
    expect(composerSteerHint({ kind: "steerable", act: "interrupt-restart", runId })).toEqual({
      shortcut: true,
      text: "to interrupt and restart with this message",
    });
  });

  it("states the run's actual phase instead of a chord when nothing is steerable", () => {
    expect(composerSteerHint({ kind: "not-steerable", phase: "finalizing", runId })).toEqual({
      shortcut: false,
      text: "Finishing up — checkpointing",
    });
    expect(composerSteerHint({ kind: "not-steerable", phase: "starting", runId })).toEqual({
      shortcut: false,
      text: "Not generating yet — starting",
    });
  });
});

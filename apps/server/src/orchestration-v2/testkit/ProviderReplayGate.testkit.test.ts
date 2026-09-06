import { describe, expect, it } from "vite-plus/test";

import { makeProviderReplayGate } from "./ProviderReplayGate.testkit.ts";

describe("ProviderReplayGate", () => {
  it("notifies early and late arrival waiters while holding the provider frame", async () => {
    const gate = makeProviderReplayGate(["held-frame"]);
    const reached = gate.waitUntilReached("held-frame");
    let emitted = false;
    const emitting = gate.beforeEmit("held-frame").then(() => {
      emitted = true;
    });

    expect(await reached).toBe(true);
    expect(await gate.waitUntilReached("held-frame")).toBe(true);
    expect(emitted).toBe(false);
    expect(await gate.waitUntilReached("unknown-frame")).toBe(false);
    gate.release("held-frame");
    await emitting;
    expect(emitted).toBe(true);
  });

  it("stops waiting when the replay consumer is interrupted", async () => {
    const label = "held-frame";
    const gate = makeProviderReplayGate([label]);
    const controller = new AbortController();
    const waiting = gate.beforeEmit(label, controller.signal);

    expect(gate.hasReached(label)).toBe(true);
    controller.abort();
    await waiting;
    expect(gate.release(label)).toBe(true);
  });
});

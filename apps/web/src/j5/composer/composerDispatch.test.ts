import { describe, expect, it } from "vite-plus/test";

import { resolveComposerDispatchMode } from "./composerDispatch";

describe("J5 resolveComposerDispatchMode", () => {
  it("starts an ordinary turn while idle or disconnected", () => {
    expect(resolveComposerDispatchMode({ phase: "ready", queueModifier: false })).toBe("auto");
    expect(resolveComposerDispatchMode({ phase: "ready", queueModifier: true })).toBe("auto");
    expect(resolveComposerDispatchMode({ phase: "disconnected", queueModifier: false })).toBe(
      "auto",
    );
  });

  it("queues by default while running and reserves the modifier chord for steering", () => {
    expect(resolveComposerDispatchMode({ phase: "running", queueModifier: false })).toBe("queue");
    expect(resolveComposerDispatchMode({ phase: "running", queueModifier: true })).toBe("steer");
  });

  it("treats a preparing or starting run as active: queue by default, steer on the chord", () => {
    expect(resolveComposerDispatchMode({ phase: "connecting", queueModifier: false })).toBe(
      "queue",
    );
    expect(resolveComposerDispatchMode({ phase: "connecting", queueModifier: true })).toBe("steer");
  });
});

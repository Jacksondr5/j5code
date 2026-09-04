import { describe, expect, it } from "vite-plus/test";

import { resolveComposerDispatchMode } from "./composerDispatch";

describe("J5 resolveComposerDispatchMode", () => {
  it("starts an ordinary turn while idle", () => {
    expect(resolveComposerDispatchMode({ phase: "ready", queueModifier: false })).toBe("auto");
    expect(resolveComposerDispatchMode({ phase: "ready", queueModifier: true })).toBe("auto");
  });

  it("queues by default while running and reserves the modifier chord for steering", () => {
    expect(resolveComposerDispatchMode({ phase: "running", queueModifier: false })).toBe("queue");
    expect(resolveComposerDispatchMode({ phase: "running", queueModifier: true })).toBe("steer");
  });
});

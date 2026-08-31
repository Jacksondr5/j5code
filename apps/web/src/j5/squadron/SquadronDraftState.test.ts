import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
});

describe("ambient Squadron scope selection", () => {
  it("advances a separate generation when Alpha is explicitly reselected", async () => {
    const snapshots: Array<() => unknown> = [];
    let subscription: ((listener: () => void) => () => void) | undefined;
    vi.doMock("react", () => ({
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscription = subscribe;
        snapshots.push(getSnapshot);
        return getSnapshot();
      },
    }));

    const {
      setAmbientSquadronId,
      useSquadronAmbientScope,
      useSquadronAmbientScopeSelectionGeneration,
    } = await import("./SquadronDraftState");
    useSquadronAmbientScope();
    useSquadronAmbientScopeSelectionGeneration();
    const onChange = vi.fn();
    subscription?.(onChange);

    setAmbientSquadronId("squadron:alpha");
    expect(snapshots.map((snapshot) => snapshot())).toEqual(["squadron:alpha", 1]);
    setAmbientSquadronId("squadron:alpha");

    expect(snapshots.map((snapshot) => snapshot())).toEqual(["squadron:alpha", 2]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

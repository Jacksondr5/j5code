import { EnvironmentId } from "@t3tools/contracts";
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
      setAmbientSquadronScope,
      useSquadronAmbientScope,
      useSquadronAmbientScopeSelectionGeneration,
    } = await import("./SquadronDraftState");
    useSquadronAmbientScope();
    useSquadronAmbientScopeSelectionGeneration();
    const onChange = vi.fn();
    subscription?.(onChange);

    setAmbientSquadronScope({
      environmentId: EnvironmentId.make("remote"),
      squadronId: "squadron:alpha",
    });
    expect(snapshots.map((snapshot) => snapshot())).toEqual([
      { environmentId: "remote", squadronId: "squadron:alpha" },
      1,
    ]);
    setAmbientSquadronScope({
      environmentId: EnvironmentId.make("remote"),
      squadronId: "squadron:alpha",
    });

    expect(snapshots.map((snapshot) => snapshot())).toEqual([
      { environmentId: "remote", squadronId: "squadron:alpha" },
      2,
    ]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("draft environment retarget", () => {
  it("carries explicit and frozen home state across environments without copying ambient scope", async () => {
    const {
      copyDraftSquadronScope,
      selectDraftSquadron,
      freezeDraftSquadronAtFirstSend,
      setAmbientSquadronScope,
    } = await import("./SquadronDraftState");
    selectDraftSquadron("local:reserved-retarget", "squadron:chosen");
    freezeDraftSquadronAtFirstSend("local:reserved-retarget");
    copyDraftSquadronScope("local:reserved-retarget", "remote:reserved-retarget");
    selectDraftSquadron("remote:reserved-retarget", "squadron:wrong");
    expect(freezeDraftSquadronAtFirstSend("remote:reserved-retarget")).toBe("squadron:chosen");
    setAmbientSquadronScope({
      environmentId: EnvironmentId.make("local"),
      squadronId: "squadron:ambient",
    });
    copyDraftSquadronScope("local:unselected-retarget", "remote:unselected-retarget");
    expect(freezeDraftSquadronAtFirstSend("remote:unselected-retarget")).toBeNull();
  });
});

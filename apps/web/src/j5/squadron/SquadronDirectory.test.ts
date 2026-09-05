import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const alpha = {
  squadron: { id: "squadron:alpha", name: "Alpha", createdAt: "2026-08-30T00:00:00Z" },
  projectIds: ["project:alpha"],
};
const bravo = {
  squadron: { id: "squadron:bravo", name: "Bravo", createdAt: "2026-08-30T00:00:00Z" },
  projectIds: ["project:bravo"],
};

afterEach(() => {
  vi.doUnmock("react");
  vi.doUnmock("./squadronClient");
  vi.resetModules();
});

describe("Squadron directory refresh", () => {
  it("runs one trailing forced read when creation refreshes during an in-flight directory read", async () => {
    let resolveInitial: ((squadrons: ReadonlyArray<typeof alpha>) => void) | undefined;
    const listSquadrons = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReadonlyArray<typeof alpha>>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValueOnce([alpha, bravo]);
    vi.doMock("./squadronClient", () => ({ listSquadrons }));

    const { refreshSquadronDirectory } = await import("./SquadronDirectory");
    const initialRead = refreshSquadronDirectory();
    const forcedRead = refreshSquadronDirectory({ force: true });
    resolveInitial?.([alpha]);

    await Promise.all([initialRead, forcedRead]);
    expect(listSquadrons).toHaveBeenCalledTimes(2);
  });

  it("keeps the last-known directory and permits a later retry after a failed refresh", async () => {
    let readSnapshot: (() => unknown) | undefined;
    const listSquadrons = vi
      .fn()
      .mockResolvedValueOnce([alpha])
      .mockRejectedValueOnce(new Error("temporary directory failure"))
      .mockResolvedValueOnce([alpha, bravo]);
    vi.doMock("react", () => ({
      useEffect: () => undefined,
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => {
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.doMock("./squadronClient", () => ({ listSquadrons }));

    const { refreshSquadronDirectory, useSquadronDirectory } = await import("./SquadronDirectory");
    await refreshSquadronDirectory();
    useSquadronDirectory();
    await refreshSquadronDirectory({ force: true });

    expect(readSnapshot?.()).toEqual({ status: "error", squadrons: [alpha] });

    await refreshSquadronDirectory();
    expect(listSquadrons).toHaveBeenCalledTimes(3);
  });
});

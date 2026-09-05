import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ChatComposerProps } from "./ChatComposer";

afterEach(() => {
  vi.doUnmock("react");
  vi.doUnmock("../../j5/composer/useJ5SteerState");
  vi.resetModules();
});

describe("ChatComposer", () => {
  it("does not subscribe a reserved draft ID, then subscribes it after server handoff", async () => {
    const reservedThreadId = ThreadId.make("reserved-draft-thread");
    const environmentId = EnvironmentId.make("environment-1");
    const stopAfterSteerHook = new Error("stop after steer hook");
    const useJ5SteerState = vi.fn(() => {
      throw stopAfterSteerHook;
    });

    vi.doMock("react", async (importOriginal) => ({
      ...(await importOriginal<typeof import("react")>()),
      memo: (component: unknown) => component,
    }));
    vi.doMock("../../j5/composer/useJ5SteerState", () => ({ useJ5SteerState }));

    const { ChatComposer } = await import("./ChatComposer");
    const renderUntilSteerHook = (isServerThread: boolean) => {
      expect(() =>
        (ChatComposer as unknown as (props: ChatComposerProps) => unknown)({
          environmentId,
          activeThreadId: reservedThreadId,
          isServerThread,
        } as ChatComposerProps),
      ).toThrow(stopAfterSteerHook);
    };

    renderUntilSteerHook(false);
    renderUntilSteerHook(true);

    expect(useJ5SteerState).toHaveBeenNthCalledWith(1, environmentId, null);
    expect(useJ5SteerState).toHaveBeenNthCalledWith(2, environmentId, reservedThreadId);
  });
});

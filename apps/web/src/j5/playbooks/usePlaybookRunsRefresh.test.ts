import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { usePlaybookRunsRefresh } from "./usePlaybookRunsRefresh";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("lets slow reads finish, pauses when hidden, refreshes on return, and stops on unmount", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const refresh = vi.fn();
  function Consumer({ pending }: { pending: boolean }) {
    usePlaybookRunsRefresh(refresh, !pending);
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Consumer, { pending: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => {
    renderer!.update(createElement(Consumer, { pending: false }));
  });
  await act(async () => {
    vi.advanceTimersByTime(2_500);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer!.update(createElement(Consumer, { pending: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer!.update(createElement(Consumer, { pending: false }));
  });
  document.visibilityState = "hidden";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event("focus"));
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  document.visibilityState = "visible";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.advanceTimersByTime(10_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps polling an empty supported thread and pauses while unsupported or disconnected", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const refresh = vi.fn();
  function Consumer({ enabled }: { enabled: boolean }) {
    usePlaybookRunsRefresh(refresh, enabled);
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Consumer, { enabled: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(5_000);
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => {
    renderer!.update(createElement(Consumer, { enabled: false }));
  });
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => {
    renderer!.update(createElement(Consumer, { enabled: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(2_500);
  });
  expect(refresh).toHaveBeenCalledTimes(3);
});

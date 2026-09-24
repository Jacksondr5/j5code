import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useActivePlaybookRefresh } from "./useActivePlaybookRefresh";

const appState = vi.hoisted(() => ({
  currentState: "active",
  listeners: new Set<() => void>(),
  addEventListener(_event: string, listener: () => void) {
    appState.listeners.add(listener);
    return { remove: () => appState.listeners.delete(listener) };
  },
}));
vi.mock("react-native", () => ({ AppState: appState }));

const input = {
  focused: true,
  connected: true,
  supported: true,
  activeRun: false,
  isPending: false,
  refreshKey: "turn-1:running:0",
  refresh: vi.fn(),
};
let renderer: ReactTestRenderer | undefined;
function Consumer(props: typeof input) {
  useActivePlaybookRefresh(props);
  return null;
}
async function render(overrides: Partial<typeof input> = {}) {
  await act(async () => {
    const element = createElement(Consumer, { ...input, ...overrides });
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appState.currentState = "active";
  input.refresh.mockClear();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(appState.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("discovers the first run within the same turn without idle polling, deferring changes during a read", async () => {
  await render();
  input.refresh.mockClear();
  vi.advanceTimersByTime(60_000);
  expect(input.refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);

  await render({ refreshKey: "turn-1:running:1" });
  expect(input.refresh).toHaveBeenCalledTimes(1);
  await render({ refreshKey: "turn-1:running:2", isPending: true });
  expect(input.refresh).toHaveBeenCalledTimes(1);
  await render({ refreshKey: "turn-1:running:2" });
  expect(input.refresh).toHaveBeenCalledTimes(2);
  await render({ refreshKey: "turn-1:running:2" });
  expect(input.refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the active-run timer stable through reads and pauses in the background", async () => {
  const schedule = vi.spyOn(globalThis, "setInterval");
  await render({ activeRun: true });
  input.refresh.mockClear();
  await render({ activeRun: true, isPending: true });
  vi.advanceTimersByTime(7_500);
  expect(input.refresh).not.toHaveBeenCalled();
  await render({ activeRun: true });
  vi.advanceTimersByTime(7_500);
  expect(input.refresh).toHaveBeenCalledTimes(1);
  expect(schedule).toHaveBeenCalledTimes(1);

  appState.currentState = "background";
  appState.listeners.forEach((listener) => listener());
  await render({ activeRun: true, refreshKey: "turn-1:running:2" });
  vi.advanceTimersByTime(60_000);
  expect(input.refresh).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  appState.currentState = "active";
  appState.listeners.forEach((listener) => listener());
  expect(input.refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  await render({ refreshKey: "turn-1:running:2" });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["focused", "connected", "supported"] as const)(
  "defers turn refreshes while %s is false",
  async (guard) => {
    await render({ [guard]: false });
    await render({ [guard]: false, refreshKey: "turn-1:running:2" });
    expect(input.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await render({ refreshKey: "turn-1:running:2" });
    expect(input.refresh).toHaveBeenCalledTimes(1);
  },
);

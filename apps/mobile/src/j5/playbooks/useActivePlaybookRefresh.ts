import { useEffect, useRef } from "react";
import { AppState } from "react-native";

/** Refresh on playbook changes, thread turns, and return; only an active run keeps a foreground timer. */
export function useActivePlaybookRefresh(input: {
  focused: boolean;
  connected: boolean;
  supported: boolean;
  activeRun: boolean;
  isPending: boolean;
  refreshKey: string;
  refresh: () => void;
}) {
  const latest = useRef(input);
  const lastRefreshKey = useRef(input.refreshKey);
  useEffect(() => {
    latest.current = input;
  });
  useEffect(() => {
    if (!input.focused || !input.connected || !input.supported) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = () => {
      if (AppState.currentState === "active" && !latest.current.isPending) {
        lastRefreshKey.current = latest.current.refreshKey;
        latest.current.refresh();
      }
    };
    const sync = () => {
      clearInterval(timer);
      if (input.activeRun && AppState.currentState === "active")
        timer = setInterval(refresh, 7_500);
    };
    const onAppState = () => {
      sync();
      refresh();
    };
    sync();
    refresh();
    const subscription = AppState.addEventListener("change", onAppState);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [input.focused, input.connected, input.supported, input.activeRun]);
  useEffect(() => {
    if (
      !input.focused ||
      !input.connected ||
      !input.supported ||
      input.isPending ||
      AppState.currentState !== "active" ||
      lastRefreshKey.current === input.refreshKey
    )
      return;
    lastRefreshKey.current = input.refreshKey;
    latest.current.refresh();
  }, [input.focused, input.connected, input.supported, input.isPending, input.refreshKey]);
}
